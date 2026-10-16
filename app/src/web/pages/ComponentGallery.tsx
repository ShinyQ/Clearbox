import { useRef } from "react";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { ButtonsCard, EmptyCard, FeedbackCard, InputsCard } from "./gallery/GalleryControls.tsx";
import { BarsCard, RowsCard, ScaleCard, TagsCard } from "./gallery/GalleryReview.tsx";

/** UI spec 5.7: mockup section 7 as live components for visual QA. Registered only in development. */
export function ComponentGallery() {
  useDocumentTitle("Components · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <div>
      <PageHeader title="Components" titleRef={titleRef} />
      <div className="grid grid-cols-1 gap-3.5 p-4 xl:grid-cols-2">
        <ButtonsCard />
        <TagsCard />
        <ScaleCard />
        <RowsCard />
        <FeedbackCard />
        <InputsCard />
        <EmptyCard />
        <BarsCard />
      </div>
    </div>
  );
}
