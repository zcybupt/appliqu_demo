import { forwardRef, useCallback, useRef, useState } from "react";

import templateImage from "../../../files/template.png";

import type { ReportLayout, ReportPdfItem } from "../../types";

const DEFAULT_REQUIREMENTS = "1. 请填写该贴花的技术要求。";

interface ReportTemplatePageProps {
  item: ReportPdfItem;
  pageIndex: number;
  totalPages: number;
  layout: ReportLayout;
  onLayoutChange?: (next: ReportLayout) => void;
}

export const ReportTemplatePage = forwardRef<HTMLDivElement, ReportTemplatePageProps>(
  function ReportTemplatePage({ item, pageIndex, totalPages, layout, onLayoutChange }, ref) {
    const pageRef = useRef<HTMLDivElement | null>(null);
    const dragStateRef = useRef<{
      type: "image" | "technical";
      pointerId: number;
      startX: number;
      startY: number;
      startOffsetX: number;
      startOffsetY: number;
    } | null>(null);
    const [draggingType, setDraggingType] = useState<"image" | "technical" | null>(null);

    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        pageRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref]
    );

    const startDrag = useCallback(
      (type: "image" | "technical", event: React.PointerEvent<HTMLDivElement>) => {
        if (!onLayoutChange) return;

        event.preventDefault();
        const currentOffset = layout[type];
        dragStateRef.current = {
          type,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startOffsetX: currentOffset.x,
          startOffsetY: currentOffset.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraggingType(type);
      },
      [layout, onLayoutChange]
    );

    const handlePointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (!onLayoutChange || !dragStateRef.current) return;
        const drag = dragStateRef.current;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;

        onLayoutChange({
          ...layout,
          [drag.type]: {
            x: Math.round(drag.startOffsetX + deltaX),
            y: Math.round(drag.startOffsetY + deltaY),
          },
        });
      },
      [layout, onLayoutChange]
    );

    const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (dragStateRef.current && event.currentTarget.hasPointerCapture(dragStateRef.current.pointerId)) {
        event.currentTarget.releasePointerCapture(dragStateRef.current.pointerId);
      }
      dragStateRef.current = null;
      setDraggingType(null);
    }, []);

    return (
      <div
        ref={setRefs}
        className="report-page"
        style={{ backgroundImage: `url(${templateImage})` }}
        data-report-page
      >
        <div className="report-page__overlay" data-report-overlay>
          <div className="report-page__model-top">
            <span>{item.model}</span>
          </div>

          <div
            className={`report-page__image-frame report-page__drag-target${draggingType === "image" ? " is-dragging" : ""}`}
            style={{ transform: `translate(${layout.image.x}px, ${layout.image.y}px)` }}
            onPointerDown={(event) => startDrag("image", event)}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {onLayoutChange ? <span className="report-page__drag-badge">拖动图片</span> : null}
            <img src={item.image.dataUrl} alt={item.image.name} crossOrigin="anonymous" />
          </div>

          <div
            className={`report-page__technical report-page__drag-target${draggingType === "technical" ? " is-dragging" : ""}`}
            style={{ transform: `translate(${layout.technical.x}px, ${layout.technical.y}px)` }}
            onPointerDown={(event) => startDrag("technical", event)}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {onLayoutChange ? <span className="report-page__drag-badge">拖动技术要求</span> : null}
            {item.technicalRequirements.trim() || DEFAULT_REQUIREMENTS}
          </div>

          <div className="report-page__decal-name">{item.decalName}</div>
          <div className="report-page__decal-type">{item.decalType}</div>
          <div className="report-page__model-info">{item.model}</div>
          <div className="report-page__material">{item.material}</div>
          <div className="report-page__page-total">{totalPages}</div>
          <div className="report-page__page-current">{pageIndex + 1}</div>
        </div>
      </div>
    );
  }
);
