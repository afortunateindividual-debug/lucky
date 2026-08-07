const app = getApp();
const api = require('../../utils/api.js');

Page({
  data: { courses: [], loading: true },
  onShow() {
    if (!app.globalData.token) {
      this.setData({ loading: true });
      app.wxLogin()
        .then(() => this.load())
        .catch(() => { this.setData({ loading: false, courses: [] }); });
      return;
    }
    this.load();
  },
  load() {
    this.setData({ loading: true });
    api.getMyCourses()
      .then(d => this.setData({ courses: d.courses || [], loading: false }))
      .catch(err => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },
  openCourse(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/course-detail/course-detail?id=' + id });
  }
});
