const { request } = require('./request.js');

// 微信登录：wx.login 拿到的 code 交给后端换 openid + token
function wxLogin(code) {
  return request('/api/wx/login', 'POST', { code });
}
// 查单词（模糊匹配 word/meaning）
function getWords(q) {
  return request('/api/words?q=' + encodeURIComponent(q));
}
// 课程列表
function getCourses() {
  return request('/api/courses');
}
// 课程详情（含章节 lessons）
function getCourseDetail(id) {
  return request('/api/courses/' + id);
}
// 我的课程（需登录）
function getMyCourses() {
  return request('/api/my-courses');
}
// 加入课程（需登录）
function joinCourse(courseId) {
  return request('/api/course-join', 'POST', { courseId });
}

module.exports = { wxLogin, getWords, getCourses, getCourseDetail, getMyCourses, joinCourse };
