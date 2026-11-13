import { useEffect, useRef, useState } from 'react';

/**
 * 按住录音（模拟硬件按键）。用 MediaRecorder 录音，松开后返回音频 Blob。
 * - Chrome/安卓录 webm/opus，iOS Safari/微信录 mp4/aac，后端两种都支持
 * - 首次按下会弹麦克风授权：授权期间就松手的，这次录音作废，提示再按一次
 */
export type RecorderState = 'idle' | 'starting' | 'recording';

const MAX_MS = 60_000;
const MIN_MS = 600;

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) ?? '';
}

export function useRecorder(onAudio: (blob: Blob) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const releasedEarly = useRef(false);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const cleanup = () => {
    window.clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    setState('idle');
    setElapsed(0);
  };

  useEffect(() => cleanup, []);

  const start = async () => {
    if (!supported) return onError('当前浏览器不支持录音，请直接输入文字');
    if (state !== 'idle') return;
    releasedEarly.current = false;
    setState('starting');
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      cleanup();
      const name = (e as DOMException).name;
      return onError(name === 'NotAllowedError' ? '没有麦克风权限，请在浏览器设置里允许后重试' : `无法打开麦克风：${name}`);
    }
    if (releasedEarly.current) {
      // 授权弹窗期间已经松手：这次不录，提示用户重新按住
      cleanup();
      return onError('麦克风已就绪，请重新按住说话');
    }
    const mime = pickMime();
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const dur = Date.now() - startedAt.current;
      const blob = new Blob(chunks, { type: r.mimeType || mime || 'audio/webm' });
      cleanup();
      if (dur < MIN_MS) return onError('说话时间太短，请按住按钮说完再松开');
      onAudio(blob);
    };
    rec.current = r;
    startedAt.current = Date.now();
    r.start(250);
    setState('recording');
    timer.current = window.setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= MAX_MS) r.state === 'recording' && r.stop();
    }, 200);
  };

  const stop = () => {
    if (state === 'starting') releasedEarly.current = true;
    if (rec.current?.state === 'recording') rec.current.stop();
  };

  return { supported, state, elapsed, start, stop };
}
