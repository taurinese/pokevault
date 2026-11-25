import { Check, Copy, ExternalLink, Link2, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { loginRedirectTo } from "../lib/auth-shared.ts";
import {
  activeShareLinks,
  copyToClipboard,
  createShareLink,
  fetchShareLinks,
  formatShareDate,
  revokeShareLink,
  type ShareLinkEntry,
  sharedPagePath,
  sharedPageUrl,
  updateShareLinkQuantities,
} from "../lib/share-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const ghostButtonClass = `inline-flex min-h-11 items-center justify-center gap-2 rounded-pill border border-line bg-surface-2 px-4 text-sm font-semibold text-primary transition-colors hover:bg-surface-1 disabled:opacity-50 ${focusRing}`;
const goldButtonClass = `inline-flex min-h-11 items-center justify-center gap-2 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold transition-colors hover:bg-surface-1 disabled:opacity-50 ${focusRing}`;
const dangerButtonClass = `inline-flex min-h-11 items-center justify-center gap-2 rounded-pill border border-line bg-surface-2 px-4 text-sm font-semibold text-danger transition-colors hover:bg-surface-1 disabled:opacity-50 ${focusRing}`;

/** Durée d'affichage du retour « Lien copié ». */
const COPIED_FEEDBACK_MS = 2000;

// ---------------------------------------------------------------------------
// Briques réutilisées par la section « Partages lecture seule » de `09B`
// ---------------------------------------------------------------------------

/**
 * Retour « Lien copié » : mémorise le lien dont la copie a réussi / échoué pendant
 * `COPIED_FEEDBACK_MS` (puis revient au repos). Les minuteurs sont nettoyés au démontage.
 */
export const useCopyFeedback = () => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async (id: string, text: string) => {
    const ok = await copyToClipboard(text);
    setCopiedId(ok ? id : null);
    setFailedId(ok ? null : id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopiedId(null);
      setFailedId(null);
    }, COPIED_FEEDBACK_MS);
  }, []);
  return { copiedId, failedId, copy };
};

/** Bouton « Copier en 1 tap » avec retour visuel + annonce `role="status"`. */
export const CopyLinkButton = ({
  title,
  copied,
  failed,
  onCopy,
  testId = "share-copy",
}: {
  readonly title: string;
  readonly copied: boolean;
  readonly failed: boolean;
  readonly onCopy: () => void;
  readonly testId?: string | undefined;
}) => (
  <>
    <button
      type="button"
      data-testid={testId}
      aria-label={t("share.sheet.copyAria", { title })}
      onClick={onCopy}
      className={copied ? goldButtonClass : ghostButtonClass}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {copied ? t("share.sheet.copied") : t("share.sheet.copy")}
    </button>
    <span role="status" className="sr-only" data-testid={`${testId}-status`}>
      {copied ? t("share.sheet.copied") : failed ? t("share.sheet.copyFailed") : ""}
    </span>
  </>
);

/** Interrupteur accessible (`role="switch"`), cible tactile ≥ 44 px. */
export const ShareSwitch = ({
  checked,
  disabled = false,
  label,
  testId,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly testId: string;
  readonly onChange: (checked: boolean) => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    data-testid={testId}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`flex shrink-0 items-center justify-center disabled:opacity-50 ${focusRing}`}
    style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
  >
    <span
      aria-hidden="true"
      className={`flex h-6 w-11 items-center rounded-pill border border-line p-0.5 transition-colors ${
        checked ? "bg-gold-bar" : "bg-surface-2"
      }`}
    >
      <span
        className={`size-5 rounded-pill border border-line bg-surface-1 shadow-card transition-transform motion-reduce:transition-none ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </span>
  </button>
);

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

export type ShareLinkSheetLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready" };

export interface ShareLinkSheetViewState {
  readonly open: boolean;
  readonly binderTitle: string;
  readonly load: ShareLinkSheetLoad;
  /** Liens ACTIFS du classeur, du plus récent au plus ancien. */
  readonly links: ReadonlyArray<ShareLinkEntry>;
  /** Nom d'affichage visible publiquement (`null` : repli « Collectionneur »). */
  readonly displayName: string | null;
  /** Réglage « Afficher les quantités » d'un NOUVEAU lien. */
  readonly newShowQuantities: boolean;
  /** Origine de l'application (`https://…`), pour afficher l'URL complète `/s/<token>`. */
  readonly origin: string;
  /** `"create"` ou l'id du lien dont une action est en cours. */
  readonly busyId: string | null;
  /** Lien en attente de confirmation de révocation. */
  readonly confirmRevokeId: string | null;
  readonly copiedId: string | null;
  readonly copyFailedId: string | null;
  readonly notice: "revoked" | "error" | null;
}

export interface ShareLinkSheetViewActions {
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onNewShowQuantitiesChange: (value: boolean) => void;
  readonly onCreate: () => void;
  readonly onCopy: (link: ShareLinkEntry) => void;
  readonly onToggleQuantities: (link: ShareLinkEntry, value: boolean) => void;
  readonly onAskRevoke: (linkId: string | null) => void;
  readonly onRevoke: (link: ShareLinkEntry) => void;
}

export interface ShareLinkSheetViewProps {
  readonly state: ShareLinkSheetViewState;
  readonly actions: ShareLinkSheetViewActions;
}

const QuantitiesRow = ({
  testId,
  checked,
  disabled,
  onChange,
}: {
  readonly testId: string;
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: boolean) => void;
}) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-semibold text-primary">
        {t("share.sheet.quantities.label")}
      </span>
      <span className="text-xs text-muted">{t("share.sheet.quantities.hint")}</span>
    </div>
    <ShareSwitch
      checked={checked}
      disabled={disabled}
      label={t("share.sheet.quantities.label")}
      testId={testId}
      onChange={onChange}
    />
  </div>
);

const LinkCard = ({
  link,
  state,
  actions,
}: {
  readonly link: ShareLinkEntry;
  readonly state: ShareLinkSheetViewState;
  readonly actions: ShareLinkSheetViewActions;
}) => {
  const url = sharedPageUrl(state.origin, link.token);
  const busy = state.busyId === link.id;
  const confirming = state.confirmRevokeId === link.id;
  const title = state.binderTitle;
  return (
    <li
      data-testid="share-link"
      data-link-id={link.id}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 p-3"
    >
      <div className="flex items-center gap-2">
        <Link2 size={16} aria-hidden="true" className="shrink-0 text-gold" />
        <input
          readOnly
          data-testid="share-link-url"
          aria-label={t("share.sheet.link.label")}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className={`min-w-0 flex-1 truncate rounded-card border border-line bg-surface-1 px-3 py-2 font-mono text-xs tabular-nums text-primary ${focusRing}`}
        />
      </div>
      <p className="text-xs text-muted">
        {t("share.sheet.link.createdOn", { date: formatShareDate(link.createdAt) })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <CopyLinkButton
          title={title}
          copied={state.copiedId === link.id}
          failed={state.copyFailedId === link.id}
          onCopy={() => actions.onCopy(link)}
        />
        <a
          data-testid="share-preview"
          href={sharedPagePath(link.token)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("share.sheet.previewAria", { title })}
          className={ghostButtonClass}
        >
          <ExternalLink size={16} aria-hidden="true" />
          {t("share.sheet.preview")}
        </a>
      </div>
      <QuantitiesRow
        testId="share-link-quantities"
        checked={link.showQuantities}
        disabled={busy}
        onChange={(value) => actions.onToggleQuantities(link, value)}
      />
      {confirming ? (
        <div
          data-testid="share-revoke-confirm"
          role="alertdialog"
          aria-label={t("share.sheet.revokeConfirm")}
          className="flex flex-col gap-2 border-t border-line pt-3"
        >
          <p className="text-sm text-secondary">{t("share.sheet.revokeConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="share-revoke-yes"
              disabled={busy}
              onClick={() => actions.onRevoke(link)}
              className={dangerButtonClass}
            >
              <Trash2 size={16} aria-hidden="true" />
              {t("share.sheet.revokeConfirmYes")}
            </button>
            <button
              type="button"
              data-testid="share-revoke-cancel"
              onClick={() => actions.onAskRevoke(null)}
              className={ghostButtonClass}
            >
              {t("share.sheet.revokeCancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="share-revoke"
          aria-label={t("share.sheet.revokeAria", { title })}
          disabled={busy}
          onClick={() => actions.onAskRevoke(link.id)}
          className={`${dangerButtonClass} self-start`}
        >
          <Trash2 size={16} aria-hidden="true" />
          {t("share.sheet.revoke")}
        </button>
      )}
    </li>
  );
};

/**
 * Bottom Sheet « Partage lecture seule » (ouvert depuis le bouton Partager de `03`) : rappelle
 * le nom visible publiquement et ce qui n'est JAMAIS partagé, permet de créer un lien, régler
 * l'affichage des quantités, copier l'URL `/s/<token>` en 1 tap, ouvrir l'aperçu et révoquer.
 */
export const ShareLinkSheetView = ({ state, actions }: ShareLinkSheetViewProps) => {
  const publicName =
    state.displayName === null || state.displayName.trim() === ""
      ? t("share.public.ownerFallback")
      : state.displayName;
  return (
    <BottomSheet open={state.open} onClose={actions.onClose} title={t("share.sheet.title")}>
      <div data-testid="share-sheet" className="flex flex-col gap-4">
        <div
          data-testid="share-privacy"
          className="flex items-start gap-3 rounded-card border border-line bg-surface-2 p-3"
        >
          <ShieldCheck size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("share.sheet.publicName.label")}
            </p>
            <p data-testid="share-public-name" className="truncate text-sm font-bold text-primary">
              {publicName}
            </p>
            <p className="text-xs text-secondary">{t("share.sheet.privacy")}</p>
          </div>
        </div>

        {state.notice === "revoked" ? (
          <p
            role="status"
            data-testid="share-notice-revoked"
            className="rounded-card border border-line bg-surface-2 px-3 py-2 text-sm text-success"
          >
            {t("share.sheet.revoked")}
          </p>
        ) : null}
        {state.notice === "error" ? (
          <p
            role="alert"
            data-testid="share-notice-error"
            className="rounded-card border border-line bg-surface-2 px-3 py-2 text-sm text-danger"
          >
            {t("share.sheet.actionError")}
          </p>
        ) : null}

        {state.load.status === "loading" ? (
          <p role="status" data-testid="share-loading" className="text-sm text-secondary">
            {t("share.sheet.loading")}
          </p>
        ) : state.load.status === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" data-testid="share-error" className="text-sm text-danger">
              {t("share.sheet.error")}
            </p>
            <button
              type="button"
              data-testid="share-retry"
              onClick={actions.onRetry}
              className={ghostButtonClass}
            >
              {t("share.sheet.retry")}
            </button>
          </div>
        ) : state.links.length === 0 ? (
          <div data-testid="share-create-panel" className="flex flex-col gap-3">
            <p className="text-sm text-secondary">{t("share.sheet.empty")}</p>
            <QuantitiesRow
              testId="share-new-quantities"
              checked={state.newShowQuantities}
              disabled={state.busyId === "create"}
              onChange={actions.onNewShowQuantitiesChange}
            />
            <button
              type="button"
              data-testid="share-create"
              disabled={state.busyId === "create"}
              onClick={actions.onCreate}
              className={goldButtonClass}
            >
              <Link2 size={16} aria-hidden="true" />
              {state.busyId === "create" ? t("share.sheet.creating") : t("share.sheet.create")}
            </button>
          </div>
        ) : (
          <>
            <ul data-testid="share-links" className="flex flex-col gap-3">
              {state.links.map((link) => (
                <LinkCard key={link.id} link={link} state={state} actions={actions} />
              ))}
            </ul>
            <button
              type="button"
              data-testid="share-create"
              disabled={state.busyId === "create"}
              onClick={actions.onCreate}
              className={`${ghostButtonClass} self-start`}
            >
              {state.busyId === "create"
                ? t("share.sheet.creating")
                : t("share.sheet.createAnother")}
            </button>
          </>
        )}
      </div>
    </BottomSheet>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : charge / crée / règle / révoque les liens du classeur
// ---------------------------------------------------------------------------

export interface ShareLinkSheetProps {
  readonly open: boolean;
  readonly binderId: string;
  readonly binderTitle: string;
  readonly onClose: () => void;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export const ShareLinkSheet = ({ open, binderId, binderTitle, onClose }: ShareLinkSheetProps) => {
  const [load, setLoad] = useState<ShareLinkSheetLoad>({ status: "loading" });
  const [links, setLinks] = useState<ReadonlyArray<ShareLinkEntry>>([]);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [newShowQuantities, setNewShowQuantities] = useState(true);
  const [origin, setOrigin] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [notice, setNotice] = useState<"revoked" | "error" | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const { copiedId, failedId, copy } = useCopyFeedback();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryToken` relance volontairement le chargement
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setOrigin(window.location.origin);
    setLoad({ status: "loading" });
    setNotice(null);
    setConfirmRevokeId(null);
    fetchShareLinks({ binderId, signal: controller.signal })
      .then((result) => {
        if (result.kind === "ok") {
          setLinks(activeShareLinks(result.payload.links));
          setDisplayName(result.payload.owner.displayName);
          setLoad({ status: "ready" });
        } else if (result.kind === "unauthorized") {
          window.location.assign(loginRedirectTo(`/binder/${encodeURIComponent(binderId)}`));
        } else {
          setLoad({ status: "error" });
        }
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setLoad({ status: "error" });
      });
    return () => controller.abort();
  }, [open, binderId, retryToken]);

  const replaceLink = (link: ShareLinkEntry) =>
    setLinks((current) => current.map((entry) => (entry.id === link.id ? link : entry)));

  const create = async () => {
    setBusyId("create");
    setNotice(null);
    const result = await createShareLink({ binderId, showQuantities: newShowQuantities });
    setBusyId(null);
    if (result.kind === "ok") setLinks((current) => [result.link, ...current]);
    else if (result.kind === "unauthorized") {
      window.location.assign(loginRedirectTo(`/binder/${encodeURIComponent(binderId)}`));
    } else setNotice("error");
  };

  const toggleQuantities = async (link: ShareLinkEntry, value: boolean) => {
    setBusyId(link.id);
    setNotice(null);
    const result = await updateShareLinkQuantities(link.id, value);
    setBusyId(null);
    if (result.kind === "ok") replaceLink(result.link);
    else setNotice("error");
  };

  const revoke = async (link: ShareLinkEntry) => {
    setBusyId(link.id);
    setNotice(null);
    const result = await revokeShareLink(link.id);
    setBusyId(null);
    setConfirmRevokeId(null);
    if (result.kind === "ok" || result.kind === "not-found") {
      // Mise à jour immédiate : le lien disparaît de la liste dès la révocation confirmée.
      setLinks((current) => current.filter((entry) => entry.id !== link.id));
      setNotice("revoked");
    } else setNotice("error");
  };

  return (
    <ShareLinkSheetView
      state={{
        open,
        binderTitle,
        load,
        links,
        displayName,
        newShowQuantities,
        origin,
        busyId,
        confirmRevokeId,
        copiedId,
        copyFailedId: failedId,
        notice,
      }}
      actions={{
        onClose,
        onRetry: () => setRetryToken((token) => token + 1),
        onNewShowQuantitiesChange: setNewShowQuantities,
        onCreate: () => void create(),
        onCopy: (link) => void copy(link.id, sharedPageUrl(origin, link.token)),
        onToggleQuantities: (link, value) => void toggleQuantities(link, value),
        onAskRevoke: setConfirmRevokeId,
        onRevoke: (link) => void revoke(link),
      }}
    />
  );
};
