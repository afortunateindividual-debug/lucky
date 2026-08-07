const { BASE_URL } = require('./utils/config.js');
const api = require('./utils/api.js');

App({
  globalData: {
    BASE_URL: BASE_URL,
    token: '',
    user: null
  },

  onLaunch() {
    try {
      this.globalData.token = wx.getStorageSync('token') || '';
      this.globalData.user = wx.getStorageSync('user') || null;
    } catch (e) {}
  },

  // 微信一键登录：wx.login → 后端 code2session 换 openid → 签发 token
  wxLogin() {
    const self = this;
    return new Promise((resolve, reject) => {
      wx.login({
        success(r) {
          if (!r.code) return reject(new Error('wx.login 未返回 code'));
          api.wxLogin(r.code)
            .then(d => {
              self.globalData.token = d.token;
              self.globalData.user = d.user;
              wx.setStorageSync('token', d.token);
              wx.setStorageSync('user', d.user);
              resolve(d);
            })
            .catch(reject);
        },
        fail() {
          reject(new Error('微信登录调用失败'));
        }
      });
    });
  },

  logout() {
    this.globalData.token = '';
    this.globalData.user = null;
    try {
      wx.removeStorageSync('token');
      wx.removeStorageSync('user');
    } catch (e) {}
  }
});
