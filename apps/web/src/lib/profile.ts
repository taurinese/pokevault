/**
 * Initiales d'avatar : même règle que le trigger SQL `handle_new_user`
 * (docs/02 §3, `profiles.avatar_initials`) — 2 lettres maximum, majuscules.
 */
export const FALLBACK_INITIALS = "CO";

export const avatarInitials = (name: string | null | undefined): string => {
  const words = (name ?? "").split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const [first, second] = words;
  if (first === undefined) return FALLBACK_INITIALS;
  const letters =
    second === undefined
      ? Array.from(first).slice(0, 2)
      : [Array.from(first)[0] ?? "", Array.from(second)[0] ?? ""];
  return letters.join("").toLocaleUpperCase("fr-FR");
};
