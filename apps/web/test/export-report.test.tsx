import { diffSchemas, parseSqlDump } from '@tdm/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffResponse, VersionMeta } from '../src/api/types';
import { ExportReportButton, type ReportModule } from '../src/features/report/ExportReportButton';

const meta = (id: number, versionNo: number): VersionMeta => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'db', schemaName: 'shop', versionNo, sourceFormat: 'sql',
  sourceFilename: `shop_v${versionNo}.sql`, note: null, uploadedBy: 'kim', uploadedAt: '2026-10-15T01:02:00.000Z',
});
const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);').model;
const target = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);').model;
const DATA: DiffResponse = { base: meta(11, 1), target: meta(12, 2), baseModel: base, targetModel: target, diff: diffSchemas(base, target), statements: [], ddl: '', renames: [] };
const realModule = () => import('../src/features/report/build-report');

// 객체 URL 함수만 대체하고(URL 생성자는 유지), 만든 Blob 과 누른 링크를 모은다
function captureDownloads() {
  const blobs: Blob[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:report'; }, revokeObjectURL: () => undefined }));
  return { blobs, click };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportReportButton', () => {
  it('누르면 리포트 모듈을 불러 HTML Blob 을 만들고 정한 파일 이름으로 내려받는다', async () => {
    const { blobs, click } = captureDownloads();
    render(<ExportReportButton data={DATA} mode="sql" layout="unified" generatedBy="park" />);
    await userEvent.setup().click(screen.getByRole('button', { name: '리포트 내보내기' }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/^db_shop_v1-v2_\d{8}-\d{4}\.html$/);
    expect(blobs[0].type).toBe('text/html;charset=utf-8');
    const html = await blobs[0].text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('park');
    expect(html).toContain('SQL Unified');
    expect(screen.getByRole('button', { name: '리포트 내보내기' })).toBeEnabled();
  });

  it('만드는 동안 버튼이 꺼지고 진행 문구를 보인다', async () => {
    const { click } = captureDownloads();
    const gate = deferred<ReportModule>();
    render(<ExportReportButton data={DATA} mode="sql" layout="split" generatedBy="park" load={() => gate.promise} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '리포트 내보내기' }));
    expect(screen.getByRole('button', { name: '리포트 만드는 중…' })).toBeDisabled();
    gate.resolve(await realModule());
    expect(await screen.findByRole('button', { name: '리포트 내보내기' })).toBeEnabled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('실패하면 이유를 alert 로 보이고, 다시 누르면 다시 시도한다', async () => {
    const { click } = captureDownloads();
    const load = vi.fn<() => Promise<ReportModule>>().mockRejectedValueOnce(new Error('네트워크 오류')).mockImplementation(realModule);
    render(<ExportReportButton data={DATA} mode="grid" layout="split" generatedBy="park" load={load} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '리포트 내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('리포트를 만들지 못했습니다: 네트워크 오류');
    expect(click).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '리포트 내보내기' }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('추가·삭제 포함을 끄면 그 객체를 빼고 만든다', async () => {
    const { blobs, click } = captureDownloads();
    const b = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);\nCREATE TABLE `gone_t` (\n  `y` int\n);').model;
    const t = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE TABLE `new_t` (\n  `z` int\n);').model;
    render(<ExportReportButton data={{ ...DATA, baseModel: b, targetModel: t, diff: diffSchemas(b, t) }} mode="sql" layout="split" generatedBy="park" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: '삭제 포함' }));
    await user.click(screen.getByRole('button', { name: '리포트 내보내기' }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const html = await blobs[0].text();
    expect(html).toContain('new_t');
    expect(html).not.toContain('gone_t');
    expect(html).toContain('삭제된 객체');
    expect(screen.getByRole('checkbox', { name: '추가 포함' })).toBeChecked();
  });

  it('비교 결과가 없으면 꺼져 있다', () => {
    render(<ExportReportButton mode="sql" layout="split" />);
    expect(screen.getByRole('button', { name: '리포트 내보내기' })).toBeDisabled();
  });
});
