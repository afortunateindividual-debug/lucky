const api = require('../../utils/api.js');

const STAGE_ORDER = ['零基础', '小学', '初中', '高中', '大学', '实用', '职场', '雅思', '综合', '入门', 'HSK1'];

Page({
  data: { groups: [] },
  onLoad() {
    api.getCourses()
      .then(d => {
        const list = d.courses || [];
        const map = {};
        list.forEach(c => {
          const stage = c.level || '综合';
          (map[stage] = map[stage] || []).push(c);
        });
        const groups = STAGE_ORDER
          .filter(s => map[s] && map[s].length)
          .map(s => ({ stage: s, list: map[s] }));
        Object.keys(map).forEach(s => {
          if (!STAGE_ORDER.includes(s)) groups.push({ stage: s, list: map[s] });
        });
        this.setData({ groups });
      })
      .catch(err => wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' }));
  },
  openCourse(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/course-detail/course-detail?id=' + id });
  }
});
