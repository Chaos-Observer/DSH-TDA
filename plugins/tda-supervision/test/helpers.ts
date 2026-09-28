/** T3.2 测试夹具。 */
import { createJsonBackend, openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSupervisionService, type SupervisionDeps, type SupervisionService } from '../src/service.ts';
import { supervisionDomainSpec } from '../src/domain.ts';

export const NOW = 1_796_000_000_000;

export interface SetupOptions {
  readonly now?: () => number;
}

export interface Fixture {
  readonly service: SupervisionService;
  readonly domain: Awaited<ReturnType<typeof openTdaDomain>>;
  readonly dispose: () => Promise<void>;
}

export const baseInput = (overrides: Record<string, unknown> = {}) => ({
  kind: 'dispatch' as const,
  requester: { service: 'test', ref: 'req-1' },
  subject: '高风险派发：外设写入',
  whatToShow: {
    summary: '向 COM186 写入控制序列',
    impact: [{ target: 'device', change: 'execute' as const, reversible: false }],
    riskReasons: ['irreversible-device-write'],
    evidence: [{ kind: 'timeline-entry', ref: 'tl-1' }],
  },
  resume: { from: 'starting', handle: 'order-dp-1' },
  taskId: 'task-1',
  ...overrides,
});

export async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-sv-test-'));
  const backend = await createJsonBackend(dir);
  const domain = await openTdaDomain(supervisionDomainSpec, { backend });
  const deps: SupervisionDeps = {
    domain,
    session: { sessionId: 'sess-supervision' as never, append: () => 1, flush() {} },
    now: options.now ?? (() => NOW),
  };
  const service = createSupervisionService(deps);
  await service.initialize();
  return {
    service,
    domain,
    dispose: async () => {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}
