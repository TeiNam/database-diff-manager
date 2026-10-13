import { describe, expect, it } from 'vitest';
import { engineName, rowFormatName, setOption } from '../../src/apply/options';
import { ApplyFailure } from '../../src/apply/types';

describe('테이블 옵션', () => {
  const base = [{ key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_0900_ai_ci' }, { key: 'COMMENT', value: "'주문'" }];

  it('있던 옵션은 그 자리에서 바꾸고, 새 옵션은 SHOW CREATE 순서 자리에 넣고, undefined 는 지운다', () => {
    expect(setOption(base, 'COMMENT', "'새'").map((o) => o.value)).toEqual(['InnoDB', 'utf8mb4', 'utf8mb4_0900_ai_ci', "'새'"]);
    expect(setOption(base, 'ROW_FORMAT', 'DYNAMIC').map((o) => o.key)).toEqual(['ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'COMMENT']);
    expect(setOption(base, 'COMMENT', undefined).map((o) => o.key)).toEqual(['ENGINE', 'DEFAULT CHARSET', 'COLLATE']);
    expect(base).toHaveLength(4); // 입력은 그대로
  });

  it('엔진·행 형식 이름을 MySQL 표기로 맞추고 모르는 값은 거부한다', () => {
    expect(engineName('innodb')).toBe('InnoDB');
    expect(rowFormatName('dynamic')).toBe('DYNAMIC');
    expect(() => engineName('foo')).toThrow(ApplyFailure);
    expect(() => rowFormatName('weird')).toThrow(ApplyFailure);
  });
});
