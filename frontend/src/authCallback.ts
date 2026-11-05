import { AUTH_MESSAGE_TYPE, AUTH_STORAGE_KEY, getTrimApp, isValidAuthResult } from './utils/fnosBridge';

const message = document.getElementById('result');
const result = getTrimApp().parseAppAuthCallback(window.location.href);
if (result.status && isValidAuthResult(result as Parameters<typeof isValidAuthResult>[0])) {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: AUTH_MESSAGE_TYPE, result }, window.location.origin);
    window.close();
  }
  if (message) message.textContent = result.status === 'success' ? '授权完成，请返回原页面刷新目录列表。' : result.status === 'cancel' ? '已取消授权，请返回原页面。' : `授权失败：${result.error || '未知错误'}，请返回原页面。`;
} else if (message) {
  message.textContent = '授权回调无效或已过期，请返回应用重新发起授权。';
}
// Do not replay an authorization result when this callback page is refreshed.
window.history.replaceState(null, '', window.location.pathname);
