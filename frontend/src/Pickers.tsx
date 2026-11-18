export type Opt = [string, string][];

/** 누르면 바로 바뀌는 버튼 묶음 */
export function Seg({ id, label, list, cur, onPick }: { id: string; label: string; list: Opt; cur: string; onPick: (v: string) => void }) {
  return (
    <div className="pk">
      {label && <span id={`pk-${id}`}>{label}</span>}
      <div className="seg" role="group" aria-labelledby={label ? `pk-${id}` : undefined} aria-label={label ? undefined : id}>
        {list.map(([v, l]) => (
          <button key={v} type="button" aria-pressed={cur === v} onClick={() => onPick(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
