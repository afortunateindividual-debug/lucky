const app = getApp();
const api = require('../../utils/api.js');

Page({
  data: { id: null, course: {}, lessons: [], joined: false, loading: true },
  onLoad(options) {
    const id = options.id;
    this.setData({ id });
    api.getCourseDetail(id)
      .then(d => {
        const course = d.course || d;
        const lessons = (d.lessons && d.lessons.length) ? d.lessons : (course.lessons || []);
        this.setData({ course, lessons, loading: false });
      })
      .catch(err => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },
  onJoin() {
    if (!app.globalData.token) {
      wx.showLoading({ title: '登录中' });
      app.wxLogin()
        .then(() => this.doJoin())
        .catch(err => {
          wx.hideLoading();
          wx.showToast({ title: (err && err.message) || '请先登录', icon: 'none' });
        });
      return;
    }
    this.doJoin();
  },
  doJoin() {
    wx.showLoading({ title: '加入中' });
    api.joinCourse(this.data.id)
      .then(() => {
        wx.hideLoading();
        this.setData({ joined: true });
        wx.showToast({ title: '已加入课程', icon: 'success' });
      })
      .catch(err => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '加入失败', icon: 'none' });
      });
  }
});
