import type { Card as CardData } from "./types";

// Render any argument value inertly. Strings pass through unchanged (React renders
// them as text nodes — never HTML); non-strings are JSON-stringified. NOTHING here
// interprets the value as markdown, a link, HTML, or ANSI. This is the
// untrusted-input rule as code; the inertness test locks it.
function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function activeFlags(flags: Record<string, boolean>): string[] {
  return Object.entries(flags)
    .filter(([, on]) => on)
    .map(([name]) => name);
}

// A short project label from cwd/worktree — the last path segment reads better on a
// badge than the full path (the full path is still shown in the meta row).
function projectLabel(card: CardData): string | undefined {
  const path = card.worktree ?? card.cwd;
  if (path === undefined) return undefined;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export interface CardProps {
  card: CardData;
  selected?: boolean;
  denying?: boolean;
  denyReason?: string;
  onSelect?: (id: string) => void;
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  onDenyReasonChange?: (value: string) => void;
  onSubmitDeny?: (id: string) => void;
  onCancelDeny?: () => void;
}

export function Card(props: CardProps): JSX.Element {
  const { card, selected = false, denying = false } = props;
  const flags = activeFlags(card.flags);
  const project = projectLabel(card);

  return (
    <article
      className={`card${selected ? " card--selected" : ""}`}
      onClick={() => props.onSelect?.(card.id)}
      aria-selected={selected}
    >
      <header className="card__head">
        {/* Tool name is agent-supplied → inert text node, never a link. */}
        <span className="card__tool">{card.tool}</span>
        <span className="badge badge--session" title={`session ${card.session}`}>
          {card.session}
        </span>
        {project !== undefined && (
          <span className="badge badge--project" title={card.worktree ?? card.cwd}>
            {project}
          </span>
        )}
        <span className="card__tier">
          {card.policyTier !== undefined ? `tier: ${card.policyTier}` : "unmatched"}
        </span>
      </header>

      {flags.length > 0 && (
        <div className="flags" role="status">
          {flags.map((f) => (
            <span key={f} className="flag">
              {f}
            </span>
          ))}
        </div>
      )}

      <dl className="args">
        {Object.entries(card.arguments).map(([key, value]) => (
          <div className="arg" key={key}>
            <dt className="arg__key">{key}</dt>
            {/* pre + text node: commas, quotes, <script>, [md](links), and ANSI
                all render as literal characters. */}
            <dd className="arg__val">
              <pre>{stringify(value)}</pre>
            </dd>
          </div>
        ))}
      </dl>

      {(card.cwd !== undefined || card.worktree !== undefined) && (
        <div className="card__meta">
          <pre>{card.worktree ?? card.cwd}</pre>
        </div>
      )}

      <footer className="card__actions">
        {denying ? (
          <div className="deny">
            <input
              className="deny__input"
              autoFocus
              placeholder="reason (Enter to deny, Esc to cancel)"
              value={props.denyReason ?? ""}
              onChange={(e) => props.onDenyReasonChange?.(e.target.value)}
            />
            <button className="btn btn--deny" onClick={() => props.onSubmitDeny?.(card.id)}>
              Deny
            </button>
            <button className="btn" onClick={() => props.onCancelDeny?.()}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button className="btn btn--approve" onClick={() => props.onApprove?.(card.id)}>
              Approve <kbd>a</kbd>
            </button>
            <button className="btn btn--deny" onClick={() => props.onDeny?.(card.id)}>
              Deny <kbd>d</kbd>
            </button>
          </>
        )}
      </footer>
    </article>
  );
}
