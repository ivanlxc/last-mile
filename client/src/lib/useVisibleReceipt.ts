import { useEffect, useRef } from "react";
/** A receipt is evidence of display, never evidence of understanding. */
export function useVisibleReceipt(
  key: string,
  send: () => void,
  minimumVisible = 0.55,
  enabled = true,
) {
  const target = useRef<HTMLDivElement>(null);
  const latest = useRef(send);
  const displayed = useRef(new Set<string>());
  latest.current = send;
  useEffect(() => {
    const element = target.current;
    if (!element || !key || !enabled || displayed.current.has(key)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let intersecting = false,
      done = false;
    const schedule = () => {
      clearTimeout(timer);
      if (intersecting && !done && document.visibilityState === "visible")
        timer = setTimeout(() => {
          done = true;
          displayed.current.add(key);
          latest.current();
        }, 550);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting =
          entry.isIntersecting && entry.intersectionRatio >= minimumVisible;
        schedule();
      },
      { threshold: [0, minimumVisible, 1] },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [key, minimumVisible, enabled]);
  return target;
}
