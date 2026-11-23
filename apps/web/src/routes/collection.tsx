import { createFileRoute } from "@tanstack/react-router";
import { SkeletonPage } from "../components/SkeletonPage.tsx";

export const Route = createFileRoute("/collection")({
  component: () => (
    <SkeletonPage titleKey="page.collection.title" descriptionKey="page.collection.description" />
  ),
});
