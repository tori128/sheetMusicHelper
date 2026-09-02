import { useState } from "react";
import { Localized } from "../i18n";

interface StartupTermsDialogProps {
  onAccept: () => void;
  onExit: () => void;
}

const MODEL_PAGES = [
  "https://huggingface.co/MuScriptor/muscriptor-small",
  "https://huggingface.co/MuScriptor/muscriptor-medium",
  "https://huggingface.co/MuScriptor/muscriptor-large",
];

export function StartupTermsDialog({
  onAccept,
  onExit,
}: StartupTermsDialogProps) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Localized>
    <main className="startup-terms-screen">
      <section
        className="startup-terms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-terms-title"
      >
        <header className="startup-terms-dialog__header">
          <span className="brand-mark" aria-hidden="true">
            E
          </span>
          <div>
            <h1 id="startup-terms-title">MuScriptorモデルの利用条件</h1>
            <p>EarCopy Assistを起動する前に、次の条件を確認してください。</p>
          </div>
        </header>

        <div className="startup-terms-dialog__content">
          <p>
            同梱するMuScriptor small、medium、largeのモデル重みは、Kyutaiと
            Mireloが公開し、Creative Commons Attribution-NonCommercial 4.0
            International（CC BY-NC 4.0）および各モデル配布ページの追加条件で
            提供しています。
          </p>

          <ul>
            <li>モデル重みは非商用目的に限って使用できます。</li>
            <li>
              入力する楽曲について、著作権その他の必要な権利または許諾を保有している
              必要があります。
            </li>
            <li>
              モデルの利用と出力は適用法令に従い、違法または無許諾の活動に使用できません。
            </li>
            <li>
              モデルと出力は現状有姿で提供され、第三者の権利を侵害しないことを含む保証は
              ありません。
            </li>
            <li>
              追加条件への違反に起因する請求について、利用者はMireloおよびKyutaiを補償し、
              防御し、免責することに同意します。
            </li>
          </ul>

          <div className="startup-terms-dialog__sources">
            <strong>ライセンスと配布元</strong>
            <span>https://creativecommons.org/licenses/by-nc/4.0/</span>
            {MODEL_PAGES.map((url) => (
              <span key={url}>{url}</span>
            ))}
          </div>

          <p className="startup-terms-dialog__separate-rights">
            EarCopy Assist本体、モデル重み、入力する楽曲、採譜結果には、それぞれ個別の
            権利と利用条件が適用されます。
          </p>
        </div>

        <label className="startup-terms-dialog__confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>上記の利用条件を確認し、同意します</span>
        </label>

        <footer className="startup-terms-dialog__actions">
          <button type="button" className="secondary-button" onClick={onExit}>
            終了
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!confirmed}
            onClick={onAccept}
          >
            同意して起動
          </button>
        </footer>
      </section>
    </main>
    </Localized>
  );
}
