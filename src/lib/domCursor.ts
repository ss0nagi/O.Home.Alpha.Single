// DOM 커서 (5.1 v2.0) — 시스템 커서를 완전히 숨기고, 등록한 커서 이미지를 직접 그려 마우스를 따라가게 한다.
//
// 왜 CSS cursor:url() 방식을 버렸나
//  · 브라우저는 요소가 바뀔 때마다 "커서 이미지를 쓸지 / 폴백(시스템 커서)을 쓸지" 매번 다시 정한다.
//    이미지가 아직 준비 안 됐거나, 크기·창 가장자리 제한에 걸리거나, .ani 프레임을 교체하며 스타일을
//    다시 쓰는 순간에 폴백이 한 프레임씩 비쳐서 "원래 커서가 깜빡이는" 현상이 생긴다.
//  · 사이트 곳곳의 cursor:zoom-in / default / crosshair 같은 하드코딩 값도 시스템 커서로 새어 나온다.
//  → 모든 요소에 cursor:none을 걸고, 같은 위치에 이미지를 그리면 시스템 커서가 끼어들 틈이 없다.
//
// 어떤 상태의 커서를 보일지는 "원래 그 요소에 적용됐을 cursor 값"을 읽어서 정한다
//  (pointer → 포인터, text → 텍스트, grab/move → 이동, *-resize → 크기조절 …).
import { parseAni, curInfo } from './aniCursor';
import type { CursorSettings, CursorState } from './cursorStore';

const STYLE_ID = 'ohome-cursor-style';
const HOST_ID = 'ohome-cursor';
const ON_CLASS = 'oc-on';
const CACHE_MS = 800;

const TEXT_SEL = [
  'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio])',
  ':not([type=range]):not([type=color]):not([type=file]):not([type=image])',
].join('') + ', textarea, [contenteditable=""], [contenteditable="true"]';

type Intent = CursorState | 'none';

function toIntent(raw: string, el: Element): Intent {
  const kw = raw.split(',').pop()!.trim();
  switch (kw) {
    case 'none': return 'none';
    case 'pointer': case 'zoom-in': case 'zoom-out': case 'help': case 'cell':
    case 'copy': case 'alias': case 'context-menu': case 'crosshair':
      return 'pointer';
    case 'text': case 'vertical-text': return 'text';
    case 'grab': case 'grabbing': case 'move': case 'all-scroll': return 'grab';
    case 'nwse-resize': case 'nw-resize': case 'se-resize': return 'rsNwse';
    case 'nesw-resize': case 'ne-resize': case 'sw-resize': return 'rsNesw';
    case 'ew-resize': case 'e-resize': case 'w-resize': case 'col-resize': return 'rsEw';
    case 'ns-resize': case 'n-resize': case 's-resize': case 'row-resize': return 'rsNs';
    case 'auto': return el.closest(TEXT_SEL) ? 'text' : 'default';
    default: return 'default';
  }
}

interface Frame { img: HTMLImageElement }
interface Sprite { frames: Frame[]; delays: number[] }

export type BlobLoader = (id: string) => Promise<Blob | null | undefined>;

/** 켜기 — 반환값은 끄는 함수. 비동기 로딩 중에 꺼져도 안전하다. */
export function mountDomCursor(st: CursorSettings, loadBlob: BlobLoader): () => void {
  if (typeof window === 'undefined') return () => {};
  // 터치 전용 기기는 커서가 없으니 건드리지 않는다
  const fine = window.matchMedia('(any-pointer: fine)').matches;
  if (!fine) return () => {};

  const root = document.documentElement;
  let cancelled = false;
  const urls: string[] = [];
  const timers = new Set<number>();
  const offs: Array<() => void> = [];

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `html.${ON_CLASS}, html.${ON_CLASS} *, html.${ON_CLASS} *::before, html.${ON_CLASS} *::after{cursor:none !important}`;
  document.head.appendChild(style);

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;pointer-events:none;' +
    'z-index:2147483647;will-change:transform;visibility:hidden;contain:layout style;';
  document.body.appendChild(host);

  const sprites: Partial<Record<CursorState, Sprite>> = {};

  const teardown = () => {
    cancelled = true;
    offs.forEach(f => f());
    timers.forEach(t => clearTimeout(t));
    root.classList.remove(ON_CLASS);
    host.remove();
    style.remove();
    urls.forEach(u => URL.revokeObjectURL(u));
  };

  const makeImg = (blob: Blob, info: { w: number; h: number; hx: number; hy: number } | null, hx: number, hy: number) => {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    const ox = info ? info.hx : hx;
    const oy = info ? info.hy : hy;
    img.style.cssText =
      `position:absolute;left:${-ox}px;top:${-oy}px;max-width:none;max-height:none;margin:0;padding:0;` +
      'opacity:0;user-select:none;-webkit-user-drag:none;pointer-events:none;' +
      (info ? `width:${info.w}px;height:${info.h}px;` : '');
    img.src = url;
    host.appendChild(img);
    // 미리 디코딩해 두면 상태가 바뀔 때 이미지가 한 박자 늦게 뜨는 일이 없다
    img.decode().catch(() => {});
    return img;
  };

  (async () => {
    for (const key of Object.keys(st.states) as CursorState[]) {
      const entry = st.states[key];
      if (!entry) continue;
      let blob: Blob | null | undefined;
      try { blob = await loadBlob(entry.imgId); } catch { blob = null; }
      if (!blob || cancelled) continue;
      const buf = await blob.arrayBuffer();
      if (cancelled) return;
      const ani = parseAni(buf);
      if (ani) {
        const imgs = await Promise.all(ani.frames.map(async f => makeImg(f, curInfo(await f.arrayBuffer()), 0, 0)));
        if (cancelled) return;
        sprites[key] = { frames: ani.steps.map(i => ({ img: imgs[i] })), delays: ani.delays };
      } else {
        sprites[key] = { frames: [{ img: makeImg(blob, curInfo(buf), entry.hx, entry.hy) }], delays: [] };
      }
    }
    if (cancelled || Object.keys(sprites).length === 0) return;
    start();
  })();

  function start() {
    // ── 표시할 스프라이트 전환 ──
    let shown: CursorState | null = null;
    let frameIdx = 0;
    let frameTimer = 0;
    const setFrame = (sp: Sprite, i: number) => sp.frames.forEach((f, j) => { f.img.style.opacity = j === i ? '1' : '0'; });
    const showSprite = (k: CursorState | null) => {
      if (k === shown) return;
      if (shown) {
        clearTimeout(frameTimer);
        timers.delete(frameTimer);
        sprites[shown]!.frames.forEach(f => { f.img.style.opacity = '0'; });
      }
      shown = k;
      if (!k) return;
      const sp = sprites[k]!;
      frameIdx = 0;
      setFrame(sp, 0);
      if (sp.frames.length > 1) {
        const tick = () => {
          frameIdx = (frameIdx + 1) % sp.frames.length;
          setFrame(sp, frameIdx);   // 스타일시트를 다시 쓰지 않고 불투명도만 바꾸므로 깜빡임이 없다
          frameTimer = window.setTimeout(tick, sp.delays[frameIdx] ?? 100);
          timers.add(frameTimer);
        };
        frameTimer = window.setTimeout(tick, sp.delays[0] ?? 100);
        timers.add(frameTimer);
      }
    };

    // ── 요소 → 의도된 커서 상태 (잠깐 숨김 규칙을 풀고 원래 cursor 값을 읽는다. 같은 태스크 안이라 화면엔 안 비친다) ──
    let cache = new WeakMap<Element, { v: Intent; t: number }>();
    const intentOf = (el: Element): Intent => {
      const now = performance.now();
      const hit = cache.get(el);
      if (hit && now - hit.t < CACHE_MS) return hit.v;
      const was = root.classList.contains(ON_CLASS);
      if (was) root.classList.remove(ON_CLASS);
      const v = toIntent(getComputedStyle(el).cursor, el);
      if (was) root.classList.add(ON_CLASS);
      cache.set(el, { v, t: now });
      return v;
    };

    let target: Element | null = null;
    let pressed = false;
    let inside = false;

    const setHostVisible = (v: boolean) => { host.style.visibility = v ? 'visible' : 'hidden'; };

    const apply = () => {
      if (!target) return;
      const intent = intentOf(target);
      if (intent === 'none') {        // 페이지가 일부러 커서를 숨긴 곳 (영상 재생 중 등)
        root.classList.add(ON_CLASS);
        setHostVisible(false);
        return;
      }
      let want: CursorState = intent;
      if (pressed && sprites.active && intent !== 'grab' && !intent.startsWith('rs')) want = 'active';
      const use: CursorState | null = sprites[want] ? want : sprites.default ? 'default' : null;
      if (!use) {                      // 보여줄 이미지가 전혀 없으면 시스템 커서를 그대로 둔다
        root.classList.remove(ON_CLASS);
        setHostVisible(false);
        showSprite(null);
        return;
      }
      root.classList.add(ON_CLASS);
      showSprite(use);
      setHostVisible(inside);
    };

    const move = (x: number, y: number) => {
      host.style.transform = `translate3d(${x}px,${y}px,0)`;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      inside = true;
      move(e.clientX, e.clientY);
      const t = e.target as Element | null;
      if (t && t !== target) { target = t; apply(); }
      else if (host.style.visibility === 'hidden' && target) apply();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) pressed = true;
      move(e.clientX, e.clientY);
      target = e.target as Element | null;
      apply();
    };
    const onUp = () => { if (pressed) { pressed = false; apply(); } };
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget === null) { inside = false; setHostVisible(false); }
    };
    // HTML5 드래그 중에는 OS가 자체 드래그 커서를 그리므로 우리 커서를 숨긴다
    const onDragStart = () => { setHostVisible(false); };
    const onDragEnd = () => { pressed = false; inside = true; apply(); };
    const onScroll = () => { cache = new WeakMap(); };

    const add = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, cap = true) => {
      window.addEventListener(type, fn as EventListener, { capture: cap, passive: true });
      offs.push(() => window.removeEventListener(type, fn as EventListener, { capture: cap } as EventListenerOptions));
    };
    add('pointermove', onMove);
    add('pointerdown', onDown);
    add('pointerup', onUp);
    add('pointercancel', onUp);
    add('blur', onUp, false);
    add('dragstart', onDragStart);
    add('dragend', onDragEnd);
    add('scroll', onScroll);
    document.addEventListener('mouseout', onLeave);
    offs.push(() => document.removeEventListener('mouseout', onLeave));

    // 편집모드 on/off 등 body 클래스가 바뀌면 캐시 폐기 (grab/resize 커서가 바뀌므로)
    const mo = new MutationObserver(() => { cache = new WeakMap(); });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    offs.push(() => mo.disconnect());
  }

  return teardown;
}
