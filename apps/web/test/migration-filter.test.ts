import { describe, expect, it } from 'vitest';
import { filterFlowTables, type FlowFilter } from '../src/lib/migration-filter';
import { fixtureFlow } from './dms-fixture';

const names = (filter: FlowFilter, query = '') => filterFlowTables(fixtureFlow.tables, filter, query).map((t) => t.asIs ?? t.toBe);

describe('filterFlowTables', () => {
  it('필터별 테이블', () => {
    expect(names('all')).toEqual(['tb_cust', 'tb_prm', 'tb_prm_cnd', 'tb_tmp_bak', 'audit_log']);
    expect(names('renamed')).toEqual(['tb_cust', 'tb_prm', 'tb_prm_cnd']);
    expect(names('removed')).toEqual(['tb_cust', 'tb_prm']);
    expect(names('problem')).toEqual(['tb_cust']); // 룰 대상 없는 컬럼 CUST_GRD, 대응 없는 컬럼 tmp_flag
    expect(names('new')).toEqual(['tb_cust', 'audit_log']); // To-Be 에만 있는 컬럼 email, 매핑되지 않은 테이블
  });

  it('검색은 테이블·컬럼명 부분 일치(대소문자 무시)이고 필터와 함께 걸린다', () => {
    expect(names('all', 'CND_VAL')).toEqual(['tb_prm_cnd']);
    expect(names('all', ' promotion ')).toEqual(['tb_prm', 'tb_prm_cnd']);
    expect(names('removed', 'promotion')).toEqual(['tb_prm']);
    expect(names('all', 'nothing')).toEqual([]);
  });
});
