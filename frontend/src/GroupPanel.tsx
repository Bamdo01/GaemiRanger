import { useState } from 'react';
import type { useGroups } from './hooks';

type G = ReturnType<typeof useGroups>;

export default function GroupPanel({ g, holdings, onClose }: { g: G; holdings: { code: string; name: string }[]; onClose: () => void }) {
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  return (
    <aside className="panel" aria-label="그룹 편집">
      <div className="panel-head">
        <h2>그룹 편집</h2>
        <button type="button" className="btn" onClick={onClose}>
          닫기
        </button>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (!n) return;
          g.create(n);
          setNewName('');
        }}
      >
        <label className="sr" htmlFor="new-group">
          새 그룹 이름
        </label>
        <input id="new-group" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 그룹 이름" maxLength={20} />
        <button type="submit" className="btn pri">
          만들기
        </button>
      </form>

      <h3>그룹</h3>
      <ul className="glist">
        {g.groups.map((grp) => (
          <li key={grp.id}>
            {editing?.id === grp.id ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = editing.name.trim();
                  if (n) g.rename(grp.id, n);
                  setEditing(null);
                }}
              >
                <label className="sr" htmlFor={`rn-${grp.id}`}>
                  새 이름
                </label>
                <input id={`rn-${grp.id}`} autoFocus value={editing.name} onChange={(e) => setEditing({ id: grp.id, name: e.target.value })} maxLength={20} />
                <button type="submit" className="btn pri">
                  저장
                </button>
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  취소
                </button>
              </form>
            ) : (
              <div className="row">
                <span className="gname">
                  {grp.name}
                  <small>{g.count(grp.id)}종목</small>
                </span>
                <button type="button" className="btn sm" onClick={() => setEditing({ id: grp.id, name: grp.name })}>
                  이름 바꾸기
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!g.canRemove(grp)}
                  title={g.canRemove(grp) ? '그룹 지우기' : '이 업종 종목이 남아 있어서 지울 수 없어요'}
                  onClick={() => g.remove(grp.id)}
                >
                  지우기
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <h3>종목 옮기기</h3>
      <ul className="glist">
        {holdings.map((h) => (
          <li key={h.code} className="row">
            <label htmlFor={`mv-${h.code}`} className="gname">
              {h.name}
            </label>
            <select id={`mv-${h.code}`} value={g.assign[h.code]} onChange={(e) => g.move(h.code, e.target.value)}>
              {g.groups.map((grp) => (
                <option key={grp.id} value={grp.id}>
                  {grp.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>

      <p className="note">
        한 종목은 한 그룹에만 들어갑니다. 그룹을 지우면 그 안의 종목은 원래 업종 그룹으로 돌아갑니다. 지금은 이 브라우저에만 저장됩니다. 서버 저장은 백엔드를 만들 때 붙입니다.
      </p>
      <button type="button" className="btn sm" onClick={g.reset}>
        처음 상태로 (업종별)
      </button>
    </aside>
  );
}
