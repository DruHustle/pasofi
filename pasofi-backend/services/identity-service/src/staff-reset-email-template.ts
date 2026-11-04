// Self-contained email theme from pasofi-frontend/web/src/premium.css.
const shell = String.raw`<!doctype html>
<html lang="@@LANG@@"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>@@TITLE@@</title>
<style>body{margin:0;padding:0}table{border-collapse:collapse}a{color:@@ACCENT@@}p{margin:0 0 18px} @media(max-width:620px){.outer{padding:24px 12px!important}.content{padding:28px 24px!important}.heading{font-size:28px!important;line-height:34px!important}.brand{padding:24px!important}.footer{padding:24px 12px!important}} @media(prefers-color-scheme:dark){.canvas{background:#0b201e!important}.card,.brand{background:#102b29!important}.card{border-color:#47665c!important}.ink{color:#f5f8f7!important}.copy{color:#f5f8f7!important}.muted{color:#bdd7cc!important}.panel{background:#193c35!important;border-color:#47665c!important}.rule{border-color:#47665c!important}.label,.url{color:#83e7c8!important}.accent-fill,.button{background:#83e7c8!important;color:#102b29!important}.button-label{color:#102b29!important;border-color:#83e7c8!important}}</style></head>
<body class="canvas" style="background:#f5f8f7;color:#102b29;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">@@PREHEADER@@</div>
<table role="presentation" width="100%" class="canvas" style="background:#f5f8f7;"><tr><td class="outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" class="card" style="max-width:600px;background:#ffffff;border:1px solid #dce6e2;border-radius:16px;">
<tr><td class="accent-fill" style="height:5px;background:@@ACCENT@@;font-size:1px;line-height:5px;">&nbsp;</td></tr>
<tr><td class="brand rule" style="padding:28px 36px;background:#102b29;border-bottom:1px solid #dce6e2;"><table role="presentation" width="100%"><tr><td width="44" style="width:44px;"><table role="presentation"><tr><td class="accent-fill" align="center" width="40" height="40" style="width:40px;height:40px;background:@@ACCENT@@;color:#102b29;border-radius:10px;font-size:15px;font-weight:bold;letter-spacing:-.5px;">@@MONOGRAM@@</td></tr></table></td><td style="padding-left:12px;"><div class="brand-overline" style="font-size:10px;line-height:15px;letter-spacing:2px;color:#bdd7cc;font-weight:bold;">ONESA</div><div class="brand-title" style="font-size:18px;line-height:24px;font-weight:bold;color:#ffffff;">@@BRAND@@</div></td></tr></table></td></tr>
<tr><td class="content" style="padding:36px;">
<p class="label" style="font-size:11px;line-height:16px;letter-spacing:1.8px;color:#236b5d;font-weight:bold;margin:0 0 14px;">@@LABEL@@</p>
<h1 class="heading ink" style="font-size:32px;line-height:39px;letter-spacing:-.8px;color:#102b29;margin:0 0 24px;font-weight:700;overflow-wrap:anywhere;">@@HEADING@@</h1>
<div class="copy" style="font-size:16px;line-height:26px;color:#5b706b;overflow-wrap:anywhere;word-break:break-word;">@@CONTENT@@</div>
@@ACTION@@
@@FALLBACK@@
</td></tr>
<tr><td class="panel rule" style="padding:20px 36px;background:@@SOFT@@;border-top:1px solid #dce6e2;"><p class="muted" style="font-size:12px;line-height:20px;color:#5b706b;margin:0;">@@NOTE@@</p></td></tr>
</table>
<table role="presentation" width="100%" style="max-width:600px;"><tr><td class="footer muted" align="center" style="padding:24px 20px;color:#5b706b;font-size:11px;line-height:19px;letter-spacing:.2px;">@@BRAND@@ &nbsp;&middot;&nbsp; ONESA<br>@@FOOTER@@</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function staffUrl(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    return secure && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin + '/#staff' : undefined;
  } catch { return undefined; }
}

/** The code stays in the message body, never a URL, subject or inbox preheader. */
export function renderStaffResetEmail(origin: string, token: string): string {
  const action = staffUrl(origin);
  const fields: Record<string, string> = {
    LANG: 'en', TITLE: 'PasoFi staff password recovery', PREHEADER: 'Your single-use staff recovery code expires in 15 minutes.',
    BRAND: 'PasoFi', MONOGRAM: 'PF', ACCENT: '#00b894', SOFT: '#edf7f2', LABEL: 'STAFF ACCOUNT SECURITY',
    HEADING: 'Recover your staff account',
    CONTENT: `<p style="margin:0 0 18px;">A password reset was requested for your PasoFi staff account. If this was you, use the code below in the staff password recovery form.</p>
<div class="panel" style="padding:22px;margin:24px 0;background:#edf7f2;border:1px solid #dce6e2;border-radius:12px;">
<p class="muted" style="font-size:11px;line-height:18px;font-weight:bold;letter-spacing:1px;color:#5b706b;margin:0 0 12px;">SINGLE-USE RECOVERY CODE</p>
<code class="ink" style="display:block;color:#102b29;font-family:Consolas,monospace;font-size:18px;line-height:28px;letter-spacing:.6px;word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(token)}</code>
<p class="muted" style="font-size:12px;line-height:20px;color:#5b706b;margin:14px 0 0;">Expires after 15 minutes. Copy the entire code.</p></div>
<p style="margin:0 0 18px;">Your existing authenticator is still required. Never share this code.</p>`,
    ACTION: action ? `<table role="presentation" style="margin:28px 0 8px;"><tr><td class="button" bgcolor="#00b894" style="background:#00b894;border-radius:12px;mso-padding-alt:16px 24px;"><a class="button-label" href="${escapeHtml(action)}" style="display:inline-block;padding:16px 24px;color:#102b29;font-size:15px;font-weight:bold;text-decoration:none;line-height:20px;border:1px solid #00b894;border-radius:12px;">Open staff sign-in &nbsp;&#8594;</a></td></tr></table>` : '',
    FALLBACK: action ? `<p class="muted" style="font-size:12px;line-height:20px;margin:24px 0 0;">Open PasoFi, choose staff password recovery, then enter your code.</p><p style="font-size:11px;line-height:18px;margin:8px 0 0;word-break:break-all;"><a class="url" href="${escapeHtml(action)}" style="color:#236b5d;">${escapeHtml(action)}</a></p>` : '',
    NOTE: 'If you did not request this reset, ignore this message. Your password has not been changed.',
    FOOTER: 'Automated message for your PasoFi staff account.',
  };
  return shell.replace(/@@([A-Z]+)@@/g, (_, key: string) => fields[key] ?? '');
}
