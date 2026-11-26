import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import {
  canScrollInside,
  createWheelPager,
  isEditableTarget,
  type TemplateFeedDirection,
  type TemplateFeedPosition,
} from './templateFeed';

export type TemplateFeedControls = {
  position: TemplateFeedPosition;
  placement: 'side' | 'bottom';
  onStep: (direction: TemplateFeedDirection) => void;
};

/**
 * Wraps the template game preview with a rail that never covers the game: previous / next and
 * position (Remix and Share stay in the preview toolbar). Wheel and trackpad gestures over the stage margins and the rail switch
 * templates; wheel and drag inside the game iframe never reach this document, so play is untouched.
 * The wrapper always renders (feed or not) so the game below keeps its place in the tree and is not
 * reloaded when the list stops containing it.
 */
export function TemplateFeedStage({ feed, children }: { feed: TemplateFeedControls | null; children: ReactNode }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef(feed);
  feedRef.current = feed;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const pager = createWheelPager({
      onPage: direction => {
        const current = feedRef.current;
        if (current && (direction < 0 ? current.position.prevId : current.position.nextId)) current.onStep(direction);
      },
    });
    const onWheel = (event: WheelEvent) => {
      if (!feedRef.current || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (canScrollInside(event.target, root, event.deltaY)) return;
      event.preventDefault();
      pager.push(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', onWheel);
      pager.dispose();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!feed || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return;
    const direction = event.key === 'ArrowUp' || event.key === 'PageUp' ? -1
      : event.key === 'ArrowDown' || event.key === 'PageDown' ? 1
        : 0;
    if (!direction) return;
    event.preventDefault();
    if (direction < 0 ? feed.position.prevId : feed.position.nextId) feed.onStep(direction);
  };

  const placement = feed?.placement;
  const tooltipSide = placement === 'side' ? 'left' : 'top';
  return (
    <div
      ref={rootRef}
      className="om-sa-template-feed"
      data-placement={placement}
      tabIndex={feed ? -1 : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="om-sa-template-feed-stage">{children}</div>
      {feed && (
      <div className="om-sa-template-feed-rail" role="toolbar" aria-label={t('Switch template')} aria-orientation={placement === 'side' ? 'vertical' : 'horizontal'}>
        <Tooltip label={t('Previous template (↑)')} side={tooltipSide}>
          <IconButton
            variant="ghost"
            className="motion-icon-button om-sa-template-feed-button"
            aria-label={t('Previous template')}
            disabled={!feed.position.prevId}
            onClick={() => feed.onStep(-1)}
            icon={<RemixIcon name="arrow-down-s-line" size={18} style={{ transform: 'rotate(180deg)' }} />}
          />
        </Tooltip>
        <span className="om-sa-template-feed-count" aria-live="polite">
          {t('{current} / {total}', { current: feed.position.index + 1, total: feed.position.total })}
        </span>
        <Tooltip label={t('Next template (↓)')} side={tooltipSide}>
          <IconButton
            variant="ghost"
            className="motion-icon-button om-sa-template-feed-button"
            aria-label={t('Next template')}
            disabled={!feed.position.nextId}
            onClick={() => feed.onStep(1)}
            icon={<RemixIcon name="arrow-down-s-line" size={18} />}
          />
        </Tooltip>
      </div>
      )}
    </div>
  );
}
