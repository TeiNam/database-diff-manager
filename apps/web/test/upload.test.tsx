import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UploadDialog } from '../src/features/upload/UploadDialog';
import { mockApi, renderWithProviders } from './render';

const SQL = '/* Database : shop */\nCREATE TABLE `a` (\n  `x` int\n);\nCREATE TABLE `bad` (`y` int NOT NULL FOO);\n';

describe('UploadDialog', () => {
  it('파일명·헤더로 Database·Schema를 제안하고, 미리보기 경고 수를 보여 주며, 결과를 표시한다', async () => {
    const calls = mockApi({
      '/api/tree': [{ id: 1, name: 'prod-db-01', description: null, createdAt: '', schemas: [] }],
      'POST /api/uploads': { results: [{ filename: 'shop(db-01).sql', status: 'ok', versionId: 3, versionNo: 1, warnings: [{ code: 'parse-error', kind: 'table', object: 'bad', line: 5, message: '알 수 없는 컬럼 속성' }] }] },
    });
    const onClose = vi.fn();
    renderWithProviders(<UploadDialog onClose={onClose} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('파일 선택'), new File([SQL], 'shop(db-01).sql', { type: 'text/plain' }));
    const row = await screen.findByRole('group', { name: 'shop(db-01).sql' });
    expect(within(row).getByLabelText('Database')).toHaveValue('db-01');
    expect(within(row).getByLabelText('Schema')).toHaveValue('shop');
    expect(within(row).getByText('미리보기 경고 1건')).toBeInTheDocument();
    await user.clear(within(row).getByLabelText('Database'));
    await user.type(within(row).getByLabelText('Database'), 'prod-db-01');
    await user.type(within(row).getByLabelText('메모'), '첫 업로드');
    await user.click(screen.getByRole('button', { name: '업로드 1개' }));
    expect(await screen.findByText('v1 생성')).toBeInTheDocument();
    expect(screen.getByText(/bad · 줄 5 · 알 수 없는 컬럼 속성/)).toBeInTheDocument();
    const form = calls.find((c) => c.url === '/api/uploads')!.init.body as FormData;
    expect(JSON.parse(String(form.get('meta')))).toEqual([{ filename: 'shop(db-01).sql', databaseName: 'prod-db-01', schemaName: 'shop', note: '첫 업로드' }]);
    expect((form.get('files') as File).name).toBe('shop(db-01).sql');
  });

  it("제안한 'host:port' Database 가 없고 예전 이름 'host_port' 가 있으면 그쪽을 고른다", async () => {
    mockApi({ '/api/tree': [{ id: 1, name: 'db-01_3309', description: null, createdAt: '', schemas: [] }, { id: 2, name: 'db-02:3310', description: null, createdAt: '', schemas: [] }, { id: 3, name: 'db-02_3310', description: null, createdAt: '', schemas: [] }] });
    renderWithProviders(<UploadDialog onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.querySelectorAll('#known-databases option')).toHaveLength(3));
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('파일 선택'), [new File([SQL], 'shop(db-01_3309).sql'), new File([SQL], 'blog(db-02_3310).sql'), new File([SQL], 'misc(db-03_3311).sql')]);
    const db = async (name: string) => within(await screen.findByRole('group', { name })).getByLabelText('Database');
    expect(await db('shop(db-01_3309).sql')).toHaveValue('db-01_3309');
    expect(await db('blog(db-02_3310).sql')).toHaveValue('db-02:3310'); // 제안값이 이미 있으면 그대로
    expect(await db('misc(db-03_3311).sql')).toHaveValue('db-03:3311');
  });

  it('지원하지 않는 형식은 제외하고, 이름이 비면 업로드 버튼이 비활성', async () => {
    mockApi({ '/api/tree': [] });
    renderWithProviders(<UploadDialog onClose={() => undefined} />);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(screen.getByLabelText('파일 선택'), [new File(['x'], 'sheet.xlsx'), new File(['CREATE TABLE `a` (\n  `x` int\n);'], 'plain.sql')]);
    expect(await screen.findByText(/sheet.xlsx: 지원하지 않는 형식/)).toBeInTheDocument();
    const row = await screen.findByRole('group', { name: 'plain.sql' });
    expect(within(row).getByLabelText('Database')).toHaveValue('');
    expect(screen.getByRole('button', { name: '업로드 1개' })).toBeDisabled();
  });

  it('열리면 포커스가 대화상자 안으로 이동하고, 닫히면 연 버튼으로 돌아간다', async () => {
    mockApi({ '/api/tree': [] });
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = renderWithProviders(<UploadDialog onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: '정의서 업로드' })).toContainElement(document.activeElement as HTMLElement);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('Esc로 닫는다', async () => {
    mockApi({ '/api/tree': [] });
    const onClose = vi.fn();
    renderWithProviders(<UploadDialog onClose={onClose} />);
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('같은 이름의 파일과 잘못된 파일명은 담지 않는다', async () => {
    mockApi({ '/api/tree': [] });
    renderWithProviders(<UploadDialog onClose={() => undefined} />);
    const user = userEvent.setup();
    const sql = 'CREATE TABLE `a` (\n  `x` int\n);';
    await user.upload(screen.getByLabelText('파일 선택'), [new File([sql], 'a.sql'), new File([sql], 'a.sql'), new File([sql], `${'n'.repeat(256)}.sql`)]);
    await screen.findByRole('group', { name: 'a.sql' });
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByText('a.sql: 같은 이름의 파일이 이미 있습니다')).toBeInTheDocument();
    expect(screen.getByText(/파일명이 255자를 넘거나/)).toBeInTheDocument();
    await user.upload(screen.getByLabelText('파일 선택'), new File([sql], 'a.sql'));
    expect(await screen.findByText('a.sql: 같은 이름의 파일이 이미 있습니다')).toBeInTheDocument();
  });

  it('128자를 넘는 이름은 오류를 보이고 업로드를 막는다', async () => {
    mockApi({ '/api/tree': [] });
    renderWithProviders(<UploadDialog onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('파일 선택'), new File(['CREATE TABLE `a` (\n  `x` int\n);'], 'p.sql'));
    const row = await screen.findByRole('group', { name: 'p.sql' });
    await user.type(within(row).getByLabelText('Database'), 'd');
    await user.type(within(row).getByLabelText('Schema'), 's');
    expect(screen.getByRole('button', { name: '업로드 1개' })).toBeEnabled();
    await user.type(within(row).getByLabelText('Schema'), 'x'.repeat(128));
    expect(within(row).getByRole('alert')).toHaveTextContent('128자 이하');
    expect(screen.getByRole('button', { name: '업로드 1개' })).toBeDisabled();
  });

  it('성공한 파일은 목록에서 빠지고 실패한 파일만 남는다', async () => {
    mockApi({
      '/api/tree': [],
      'POST /api/uploads': { results: [
        { filename: 'ok.sql', status: 'ok', versionId: 1, versionNo: 1, warnings: [] },
        { filename: 'bad.sql', status: 'error', message: '파싱 실패', warnings: [] },
      ] },
    });
    renderWithProviders(<UploadDialog onClose={() => undefined} />);
    const user = userEvent.setup();
    const sql = 'CREATE TABLE `a` (\n  `x` int\n);';
    await user.upload(screen.getByLabelText('파일 선택'), [new File([sql], 'ok.sql'), new File([sql], 'bad.sql')]);
    for (const name of ['ok.sql', 'bad.sql']) {
      const row = await screen.findByRole('group', { name });
      await user.type(within(row).getByLabelText('Database'), 'd');
      await user.type(within(row).getByLabelText('Schema'), 's');
    }
    await user.click(screen.getByRole('button', { name: '업로드 2개' }));
    expect(await screen.findByText('v1 생성')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('group', { name: 'ok.sql' })).not.toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'bad.sql' })).toBeInTheDocument();
  });

  it('Tab은 대화상자 안에서 순환한다', async () => {
    mockApi({ '/api/tree': [] });
    renderWithProviders(<UploadDialog onClose={() => undefined} />);
    const user = userEvent.setup();
    const items = [...document.querySelectorAll<HTMLElement>('[role=dialog] button:not(:disabled), [role=dialog] input:not(:disabled)')];
    items.at(-1)!.focus();
    await user.tab();
    expect(document.activeElement).toBe(items[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(items.at(-1));
  });
});
