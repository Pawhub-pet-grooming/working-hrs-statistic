import React, { useEffect, useState } from 'react';

export default function StoreDownloadPage({ api, language }) {
  const t = (en, zh) => language === 'zh' ? zh : en;
  const [release, setRelease] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api('/manager/downloads/store-android').then(data => { if (active) setRelease(data); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  async function download() {
    setBusy(true); setError('');
    try {
      const { url } = await api('/manager/downloads/store-android/link', { method: 'POST' });
      window.location.assign(url);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <section className="card card-body android-download-card">
    <h2 className="h2">{t('Pawhub Store App', 'Pawhub 门店 App')}</h2>
    <p className="text-secondary">{t('For the Android device used for attendance in your store. Sign in with the store account.', '用于门店签到的 Android 设备，请使用门店账号登录。')}</p>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {!release && !error && <p role="status">{t('Loading…', '正在加载…')}</p>}
    {release && <><dl className="row mt-3">
      <dt className="col-sm-4">{t('Version', '版本')}</dt><dd className="col-sm-8">{release.releaseName}</dd>
      <dt className="col-sm-4">{t('File size', '文件大小')}</dt><dd className="col-sm-8">{(release.sizeBytes / 1024 / 1024).toFixed(2)} MiB</dd>
      <dt className="col-sm-4">{t('Requires', '系统要求')}</dt><dd className="col-sm-8">Android 8.0+</dd>
    </dl>
      {release.available ? <button className="btn btn-primary align-self-start" disabled={busy} onClick={download}>{busy ? t('Preparing download…', '正在准备下载…') : t('Download Store App APK', '下载门店 App 安装包')}</button> : <p role="status">{t('Store App download is unavailable.', '门店 App 暂不可下载。')}</p>}
      <details className="mt-4"><summary>SHA-256</summary><code className="text-break">{release.sha256}</code></details>
    </>}
    <h3 className="h3 mt-4">{t('Installation', '安装方法')}</h3>
    <ol><li>{t('Open this page on the store Android device and download the APK.', '在门店 Android 设备上打开此页面，下载安装包。')}</li>
      <li>{t('Open the APK and allow installation from this source when prompted.', '打开安装包，按提示允许此来源安装应用。')}</li>
      <li>{t('Install the app, connect to the internet and sign in with the store account.', '安装后连接互联网，使用门店账号登录。')}</li></ol>
  </section>;
}
