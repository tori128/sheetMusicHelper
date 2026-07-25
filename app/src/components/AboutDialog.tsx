import { useEffect, useState } from "react";
import type { AppAboutInfo, ModelProfile } from "../types";

interface AboutDialogProps {
  models: ModelProfile[];
  onClose(): void;
}

export function AboutDialog({ models, onClose }: AboutDialogProps) {
  const [about, setAbout] = useState<AppAboutInfo | null>(null);
  const [selectedNotice, setSelectedNotice] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.desktopApi
      .getAboutInfo()
      .then((result) => {
        if (active) {
          setAbout(result);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const notice = about?.notices[selectedNotice];

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
      >
        <header className="about-dialog__header">
          <h2 id="about-title">バージョン・ライセンス</h2>
          <button className="secondary-button" onClick={onClose}>
            閉じる
          </button>
        </header>

        <dl className="version-list">
          <div>
            <dt>EarCopy Assist</dt>
            <dd>{about?.appVersion ?? "確認中…"}</dd>
          </div>
          <div>
            <dt>MuScriptor</dt>
            <dd>{about?.engineVersion ?? "確認中…"}</dd>
          </div>
          <div>
            <dt>著作権表示</dt>
            <dd>Copyright © 2026 SheetMusicHelper Contributors</dd>
          </div>
        </dl>

        <h3>登録モデル</h3>
        <div className="about-models">
          {models.length === 0 ? (
            <p>登録なし</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>名前</th>
                  <th>種別</th>
                  <th>SHA-256</th>
                  <th>ライセンス</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td>{model.profileName}</td>
                    <td>{model.variant}</td>
                    <td title={model.sha256}>{model.sha256}</td>
                    <td>CC BY-NC 4.0</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <h3>ライセンス</h3>
        {error && <p className="error-message">{error}</p>}
        {about && (
          <div className="license-viewer">
            <nav aria-label="ライセンス一覧">
              {about.notices.map((item, index) => (
                <button
                  key={item.name}
                  className={index === selectedNotice ? "is-selected" : ""}
                  onClick={() => setSelectedNotice(index)}
                >
                  {item.name}
                </button>
              ))}
            </nav>
            <pre>{notice?.text ?? ""}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
