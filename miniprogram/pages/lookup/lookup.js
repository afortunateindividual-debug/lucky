const app = getApp();
const api = require('../../utils/api.js');

function parsePhrases(w) {
  try { return w.phrases ? JSON.parse(w.phrases) : []; }
  catch (e) { return []; }
}

Page({
  data: { q: '', results: [], loading: false },
  onInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() {
    const q = (this.data.q || '').trim();
    if (!q) { wx.showToast({ title: '请输入单词', icon: 'none' }); return; }
    this.setData({ loading: true });
    api.getWords(q)
      .then(d => {
        const results = (d.words || []).map(w => ({ ...w, phrasesArr: parsePhrases(w) }));
        this.setData({ results, loading: false });
      })
      .catch(err => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '查询失败', icon: 'none' });
      });
  },
  // 朗读：英文/中文走有道词典发音（免后端依赖），法文走后端 /api/tts（Edge TTS）
  speak(e) {
    const text = e.currentTarget.dataset.text;
    const lang = e.currentTarget.dataset.lang || 'en';
    if (!text) return;
    const inner = wx.createInnerAudioContext();
    let url;
    if (lang === 'fr') {
      url = app.globalData.BASE_URL + '/api/tts?text=' + encodeURIComponent(text);
    } else {
      url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&type=' + (lang === 'zh' ? '2' : '1');
    }
    inner.src = url;
    inner.play();
    inner.onError(() => wx.showToast({ title: '朗读暂不可用', icon: 'none' }));
  }
});
