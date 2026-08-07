const { BASE_URL } = require('./config.js');

function getToken() {
  try { return wx.getStorageSync('token') || ''; } catch (e) { return ''; }
}

// wx.request 封装：自动带 Bearer token；401 清登录态。
function request(path, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) header['Authorization'] = 'Bearer ' + token;
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header,
      success(res) {
        if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('user');
          reject(new Error('请先登录'));
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const msg = res.data && res.data.message ? res.data.message : ('请求失败 (' + res.statusCode + ')');
          reject(new Error(msg));
        }
      },
      fail(err) {
        reject(new Error((err && err.errMsg) ? err.errMsg : '网络错误'));
      }
    });
  });
}

module.exports = { request, BASE_URL, getToken };
