import { createFileRoute } from "@tanstack/react-router";
import { SkeletonPage } from "../components/SkeletonPage.tsx";

export const Route = createFileRoute("/alerts")({
  component: () => (
    <SkeletonPage titleKey="page.alerts.title" descriptionKey="page.alerts.description" />
  ),
});
