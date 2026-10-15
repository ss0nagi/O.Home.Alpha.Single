'use client';
// 커스텀 마우스 커서 적용 (5.1 v2.0) — 등록한 상태별 이미지를 DOM 커서로 그린다.
// 시스템 커서는 전부 숨기고(cursor:none) 이미지가 마우스를 따라다니므로, 요소를 옮길 때
// 원래 커서가 깜빡이는 현상이 없다. 실제 동작은 lib/domCursor.ts.
// 등록 안 한 상태는 기본 이미지로 대체 · 아무것도 등록 안 했거나 전체 끄면 시스템 커서 그대로.
import { useEffect } from 'react';
import { useCursorSettings } from '@/lib/cursorStore';
import { getBlob } from '@/lib/blobStore';
import { mountDomCursor } from '@/lib/domCursor';

export function CursorLayer() {
  const [st] = useCursorSettings();

  useEffect(() => {
    if (!st.enabled || Object.keys(st.states).length === 0) return;
    return mountDomCursor(st, getBlob);
  }, [st]);

  return null;
}
