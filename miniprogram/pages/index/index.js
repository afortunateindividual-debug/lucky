const app = getApp();

Page({
  data: { user: null, loggedIn: false },
  onShow() {
    this.setData({
      user: app.globalData.user,
      loggedIn: !!app.globalData.token
    });
  },
  onWxLogin() {
    wx.showLoading({ title: '登录中' });
    app.wxLogin()
      .then(d => {
        wx.hideLoading();
        this.setData({ user: d.user, loggedIn: true });
        wx.showToast({ title: '登录成功', icon: 'success' });
      })
      .catch(err => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '登录失败', icon: 'none' });
      });
  },
  goLookup() { wx.switchTab({ url: '/pages/lookup/lookup' }); },
  goGuide() { wx.switchTab({ url: '/pages/guide/guide' }); },
  goMy() { wx.switchTab({ url: '/pages/mycourses/mycourses' }); },
  onLogout() {
    app.logout();
    this.setData({ user: null, loggedIn: false });
    wx.showToast({ title: '已退出', icon: 'none' });
  }
});
