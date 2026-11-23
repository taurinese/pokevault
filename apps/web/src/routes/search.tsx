import { createFileRoute } from "@tanstack/react-router";
import { SkeletonPage } from "../components/SkeletonPage.tsx";

export const Route = createFileRoute("/search")({
  component: () => (
    <SkeletonPage titleKey="page.search.title" descriptionKey="page.search.description" />
  ),
});
