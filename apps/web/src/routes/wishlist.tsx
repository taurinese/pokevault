import { createFileRoute } from "@tanstack/react-router";
import { SkeletonPage } from "../components/SkeletonPage.tsx";

export const Route = createFileRoute("/wishlist")({
  component: () => (
    <SkeletonPage titleKey="page.wishlist.title" descriptionKey="page.wishlist.description" />
  ),
});
