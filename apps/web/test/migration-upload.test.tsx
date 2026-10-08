import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MigrationUploadDialog } from '../src/features/migration/MigrationUploadDialog';
import { DMS_JSON } from './dms-fixture';
import { json, mockApi, renderWithProviders } from './render';

const FROM = { id: 1, name: 'legacy' };
const TO = { id: 2, name: 'newapp' };
const RESULT = { migration: { id: 5, fromSchemaId: 1, toSchemaId: 2, revision: 1, filename: 'mapping.json', ruleCount: 19, note: '1차 매핑', uploadedBy: 'admin', uploadedAt: '2026-10-08T00:00:00.000Z' }, warnings: [] };
const jsonFile = (text: string, name = 'mapping.json') => new File([text], name, { type: 'application/json' });

describe('MigrationUploadDialog', () => {
  it('미리보기(룰 수·종류별 개수·Schema 이름·경고) 후 올리면 본문을 보내고 닫힌다', async () => {
    const calls = mockApi({ 'POST /api/migrations': RESULT });
    const onClose = vi.fn();
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={onClose} />);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeDisabled();
    await user.upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON));
    const preview = await screen.findByRole('region', { name: '미리보기' });
    expect(within(preview).getByText(/룰 19개/)).toBeInTheDocument();
    const counts = within(preview).getByRole('list', { name: '룰 종류별 개수' });
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'selection include 3', 'selection exclude 0', '테이블 이름변경 3', '컬럼 이름변경 9', '컬럼삭제 2', '스키마 이름변경 1', '반영하지 않는 룰 1',
    ]);
    const checks = within(preview).getByRole('list', { name: 'Schema 이름 확인' });
    expect(checks).toHaveTextContent('As-Is: 파일 legacy · Schema legacy — 일치');
    expect(checks).toHaveTextContent('To-Be: 파일 newapp · Schema newapp — 일치');
    expect(within(preview).getByText('경고 1건')).toBeInTheDocument();
    await user.type(screen.getByLabelText('메모'), '1차 매핑');
    await user.click(screen.getByRole('button', { name: '매핑 올리기' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = JSON.parse(String(calls.find((c) => c.url === '/api/migrations')!.init.body));
    expect(body).toEqual({ fromSchemaId: 1, toSchemaId: 2, filename: 'mapping.json', source: DMS_JSON, note: '1차 매핑' });
  });

  it('JSON 이 아니면 오류를 보여 주고 올리기 버튼은 비활성', async () => {
    mockApi({});
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={() => undefined} />);
    await userEvent.setup().upload(screen.getByLabelText('매핑 파일 선택'), jsonFile('{ nope', 'bad.json'));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad.json: JSON 형식이 아닙니다');
    expect(screen.queryByRole('region', { name: '미리보기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeDisabled();
  });

  it('파일의 schema 이름이 Schema 이름과 다르면 "다름" 으로 알려 주되 올릴 수 있다', async () => {
    mockApi({});
    renderWithProviders(<MigrationUploadDialog from={{ id: 1, name: 'astore' }} to={TO} onClose={() => undefined} />);
    await userEvent.setup().upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON));
    const checks = await screen.findByRole('list', { name: 'Schema 이름 확인' });
    expect(checks).toHaveTextContent('As-Is: 파일 legacy · Schema astore — 다름 (그대로 올릴 수 있습니다)');
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeEnabled();
  });

  it('서버 오류는 대화상자 안에 보여 주고 닫지 않는다', async () => {
    mockApi({ 'POST /api/migrations': json({ error: '관리자 권한이 필요합니다' }, 403) });
    const onClose = vi.fn();
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={onClose} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON));
    await user.click(await screen.findByRole('button', { name: '매핑 올리기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('관리자 권한이 필요합니다');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('열리면 포커스가 대화상자 안으로 가고, Escape 로 닫힌다', async () => {
    mockApi({});
    const onClose = vi.fn();
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: '전환 매핑 올리기' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
  it('파일을 읽지 못하면(file.text() 실패) 오류를 보여 준다', async () => {
    mockApi({});
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={() => undefined} />);
    const file = jsonFile(DMS_JSON, 'broken.json');
    file.text = () => Promise.reject(new Error('읽기 실패'));
    await userEvent.setup().upload(screen.getByLabelText('매핑 파일 선택'), file);
    expect(await screen.findByRole('alert')).toHaveTextContent('broken.json: 파일을 읽지 못했습니다');
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeDisabled();
  });

  it('연속으로 고르면 마지막에 고른 파일만 반영한다 (먼저 고른 파일이 늦게 읽혀도)', async () => {
    mockApi({});
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={() => undefined} />);
    const user = userEvent.setup();
    let finishSlow: (text: string) => void = () => undefined;
    const slow = jsonFile(DMS_JSON, 'slow.json');
    slow.text = () => new Promise<string>((resolve) => { finishSlow = resolve; });
    await user.upload(screen.getByLabelText('매핑 파일 선택'), slow);
    await user.upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON, 'fast.json'));
    const preview = await screen.findByRole('region', { name: '미리보기' });
    expect(preview).toHaveTextContent('fast.json');
    finishSlow(DMS_JSON);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('region', { name: '미리보기' })).toHaveTextContent('fast.json');
    expect(screen.getByRole('region', { name: '미리보기' })).not.toHaveTextContent('slow.json');
  });
});
