/**
 * tda-smoke 域定义：IT0 验收载体。
 *
 * 权威表 goals（invalidRecords 缺省 reject——损坏即拒绝打开）。
 * IT1 起真实插件各自定义域，冒烟插件只保留最小闭环。
 */
import { defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const SmokeGoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'done']),
  revision: z.number(),
});

export type SmokeTables = { goals: typeof SmokeGoalSchema };

export const smokeDomainSpec = defineTdaDomain({
  name: 'tda-smoke',
  version: 1,
  tables: { goals: SmokeGoalSchema },
});
