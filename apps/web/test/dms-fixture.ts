import { buildMigrationFlow, parseDmsMapping, parseSqlDump } from '@tdm/core';
import asIsSql from '../../../packages/core/test/fixtures/dms/as-is.sql?raw';
import mappingJson from '../../../packages/core/test/fixtures/dms/mapping.json?raw';
import toBeSql from '../../../packages/core/test/fixtures/dms/to-be.sql?raw';

// core 테스트와 같은 익명화 픽스처 (As-Is legacy → To-Be newapp)
export const DMS_JSON: string = mappingJson;
export const asIsModel = parseSqlDump(asIsSql).model;
export const toBeModel = parseSqlDump(toBeSql).model;
export const fixtureFlow = buildMigrationFlow(asIsModel, toBeModel, parseDmsMapping(DMS_JSON).mapping);
