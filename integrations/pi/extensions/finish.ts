/**
 * Расширение pi для chronicle: итог сессии в фоне, когда она завершается — выход, `/new`, `/resume`, `/fork`
 * (как `SessionEnd` у Claude Code); в новой сессии — уведомление о результате.
 * Вся работа — в `chronicle finish` (см. docs/agent-contract.md).
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/** Минимум API pi, которым пользуется расширение */
export interface PiContext {
  mode: 'tui' | 'rpc' | 'json' | 'print';
  ui: { notify?: (message: string, level: 'info' | 'warning' | 'error') => void };
  sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
}

export interface PiEvent {
  reason?: string;
  /** У `session_start` после `/new`, `/resume`, `/fork` — файл прошлой сессии */
  previousSessionFile?: string;
}

interface PiApi {
  on(event: string, handler: (event: PiEvent, ctx: PiContext) => unknown): void;
}

/** Запуск CLI chronicle (в тестах — заглушка) */
export type ChronicleRun = (args: string[]) => { status: number | null; stdout: string; stderr: string };

interface LastFinish {
  sessionId: string;
  status: 'running' | 'reported' | 'skipped' | 'failed';
  summary?: string;
  knowledge?: number;
  reason?: string;
}

/** Режимы с живым человеком; `pi -p` (в том числе выжимка самого chronicle) — без итога */
const MODES: readonly PiContext['mode'][] = ['tui', 'rpc'];
/** Смена сессии, после которой стоит сообщить об итоге прошлой */
const SWITCHES = ['new', 'resume', 'fork'];
/** Дольше выжимка не идёт (таймаут агента — 10 мин, плюс повтор) */
const POLL_LIMIT_MS = 25 * 60_000;

const runChronicle: ChronicleRun = (args) => {
  const res = spawnSync('chronicle', args, { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr || res.error?.message || '' };
};

/** Файл сессии: <время>_<uuid>.jsonl */
function idOfFile(file: string): string | undefined {
  return basename(file, '.jsonl').split('_').pop() || undefined;
}

function sessionIdOf(ctx: PiContext): string | undefined {
  const id = ctx.sessionManager?.getSessionId?.();
  if (id) return id;
  const file = ctx.sessionManager?.getSessionFile?.();
  return file ? idOfFile(file) : undefined;
}

export default function chronicleFinish(pi: PiApi, deps: { chronicle?: ChronicleRun; pollMs?: number } = {}) {
  const chronicle = deps.chronicle ?? runChronicle;
  const pollMs = deps.pollMs ?? 3000;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopWaiting = () => {
    clearInterval(timer);
    timer = undefined;
  };

  const lastFinish = (): LastFinish | null => {
    const res = chronicle(['last', '--agent', 'pi']);
    try {
      return res.status === 0 ? (JSON.parse(res.stdout) as LastFinish | null) : null;
    } catch {
      return null;
    }
  };

  /** Ждёт итог фонового finish прошлой сессии и сообщает о нём; пропущенный (пустая сессия) — молча */
  const notifyWhenDone = (sessionId: string, ui: PiContext['ui']) => {
    const started = Date.now();
    timer = setInterval(() => {
      const last = lastFinish();
      const done = last?.sessionId === sessionId && last.status !== 'running';
      if (!done && Date.now() - started < POLL_LIMIT_MS) return;
      stopWaiting();
      if (!done || !last) ui.notify?.('chronicle: итог прошлой сессии так и не пришёл — см. finish.log', 'warning');
      else if (last.status === 'reported') {
        const knowledge = last.knowledge ? `, +${last.knowledge} в базу знаний` : '';
        ui.notify?.(`✓ Итог прошлой сессии отправлен: ${last.summary}${knowledge}`, 'info');
      } else if (last.status === 'failed') {
        ui.notify?.(`✖ Итог прошлой сессии не получен: ${last.reason} (см. finish.log)`, 'error');
      }
    }, pollMs);
  };

  pi.on('session_shutdown', (event, ctx) => {
    stopWaiting();
    if (event.reason === 'reload' || !MODES.includes(ctx.mode)) return;
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return;
    // --detach возвращается сразу: выжимка и отправка идут отдельным процессом и переживают выход pi
    const res = chronicle(['finish', '--agent', 'pi', '--session', sessionId, '--detach']);
    if (res.status !== 0) ctx.ui.notify?.(`chronicle: ${res.stderr.trim() || 'ошибка запуска'}`, 'error');
  });

  pi.on('session_start', (event, ctx) => {
    if (!SWITCHES.includes(event.reason ?? '') || !event.previousSessionFile || !MODES.includes(ctx.mode)) return;
    const previous = idOfFile(event.previousSessionFile);
    if (!previous) return;
    ctx.ui.notify?.('Итог прошлой сессии формируется в фоне', 'info');
    notifyWhenDone(previous, ctx.ui);
  });
}
