import { describe, expect, test } from 'bun:test';
import chronicleFinish, { type ChronicleRun, type PiContext, type PiEvent } from './finish.ts';

type Handler = (event: PiEvent, ctx: PiContext) => unknown;

function setup(last: () => unknown = () => null) {
  const handlers = new Map<string, Handler[]>();
  const commands: string[] = [];
  const runs: string[][] = [];
  const notices: { message: string; level: string }[] = [];
  let finishFails = false;
  const chronicle: ChronicleRun = (args) => {
    runs.push(args);
    if (args[0] === 'last') return { status: 0, stdout: JSON.stringify(last()), stderr: '' };
    return finishFails ? { status: 1, stdout: '', stderr: 'нет конфига' } : { status: 0, stdout: '', stderr: '' };
  };
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name: string) => commands.push(name),
  };
  chronicleFinish(pi, { chronicle, pollMs: 5 });
  const ctx = (mode: PiContext['mode'] = 'tui', sessionId = 'sess-1'): PiContext => ({
    mode,
    ui: { notify: (message, level) => notices.push({ message, level }) },
    sessionManager: { getSessionId: () => sessionId },
  });
  const emit = async (event: string, payload: PiEvent, context = ctx()) => {
    for (const h of handlers.get(event) ?? []) await h(payload, context);
  };
  return {
    commands,
    runs,
    notices,
    emit,
    ctx,
    failFinish: () => {
      finishFails = true;
    },
  };
}

const finishOf = (id: string) => ['finish', '--agent', 'pi', '--session', id, '--detach'];

describe('chronicle для pi — итог по завершении сессии', () => {
  test('/finish больше нет: итог сам при выходе и смене сессии', () => {
    expect(setup().commands).toEqual([]);
  });

  test('выход, /new, /resume, /fork — итог уходящей сессии в фоне', async () => {
    for (const reason of ['quit', 'new', 'resume', 'fork']) {
      const k = setup();
      await k.emit('session_shutdown', { reason });
      expect(k.runs).toEqual([finishOf('sess-1')]);
    }
  });

  test('/reload — та же сессия, итога нет', async () => {
    const k = setup();
    await k.emit('session_shutdown', { reason: 'reload' });
    expect(k.runs).toEqual([]);
  });

  test('pi -p (print, json) — без итога', async () => {
    const k = setup();
    await k.emit('session_shutdown', { reason: 'quit' }, k.ctx('print'));
    await k.emit('session_shutdown', { reason: 'quit' }, k.ctx('json'));
    expect(k.runs).toEqual([]);
  });

  test('chronicle не запустился — ошибка в pi', async () => {
    const k = setup();
    k.failFinish();
    await k.emit('session_shutdown', { reason: 'new' });
    expect(k.notices).toEqual([{ message: 'chronicle: нет конфига', level: 'error' }]);
  });
});

describe('chronicle для pi — результат в новой сессии', () => {
  const previousSessionFile = '/home/nur/.pi/agent/sessions/x/2026-11-16T10-00-00_sess-1.jsonl';

  test('новая сессия после /new — сообщает, когда итог прошлой отправлен', async () => {
    let last: unknown = { sessionId: 'sess-1', status: 'running' };
    const k = setup(() => last);
    await k.emit('session_start', { reason: 'new', previousSessionFile }, k.ctx('tui', 'sess-2'));
    expect(k.notices).toEqual([{ message: 'Итог прошлой сессии формируется в фоне', level: 'info' }]);
    last = { sessionId: 'sess-1', status: 'reported', summary: 'herald: расширение pi', knowledge: 2 };
    for (let i = 0; i < 100 && k.notices.length < 2; i++) await Bun.sleep(5);
    expect(k.notices[1]).toEqual({
      message: '✓ Итог прошлой сессии отправлен: herald: расширение pi, +2 в базу знаний',
      level: 'info',
    });
  });

  test('пустая сессия (итог пропущен) — без шума', async () => {
    const k = setup(() => ({ sessionId: 'sess-1', status: 'skipped', reason: 'нет реплик' }));
    await k.emit('session_start', { reason: 'new', previousSessionFile }, k.ctx('tui', 'sess-2'));
    await Bun.sleep(30);
    expect(k.notices).toEqual([{ message: 'Итог прошлой сессии формируется в фоне', level: 'info' }]);
  });

  test('сбой итога — ошибка в pi', async () => {
    const k = setup(() => ({ sessionId: 'sess-1', status: 'failed', reason: 'таймаут' }));
    await k.emit('session_start', { reason: 'resume', previousSessionFile }, k.ctx('tui', 'sess-2'));
    for (let i = 0; i < 100 && k.notices.length < 2; i++) await Bun.sleep(5);
    expect(k.notices[1]).toEqual({
      message: '✖ Итог прошлой сессии не получен: таймаут (см. finish.log)',
      level: 'error',
    });
  });

  test('запуск pi и /reload — ничего не сообщает', async () => {
    const k = setup();
    await k.emit('session_start', { reason: 'startup' });
    await k.emit('session_start', { reason: 'reload', previousSessionFile });
    expect(k.notices).toEqual([]);
  });

  test('ожидание итога останавливается с концом сессии', async () => {
    const k = setup(() => ({ sessionId: 'sess-1', status: 'running' }));
    await k.emit('session_start', { reason: 'new', previousSessionFile }, k.ctx('tui', 'sess-2'));
    await k.emit('session_shutdown', { reason: 'reload' });
    const polls = k.runs.length;
    await Bun.sleep(30);
    expect(k.runs.length).toBe(polls);
  });
});
