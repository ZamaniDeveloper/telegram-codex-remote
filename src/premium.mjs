// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { isPrivateOwner } from './auth.mjs';

const normalize = text => text.replaceAll('\uFE0F', '');
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const first = text => segmenter.segment(text)[Symbol.iterator]().next().value?.segment || '';
const validId = id => typeof id === 'string' && /^\d{1,25}$/.test(id);
const validIcon = s => s && validId(s.id) && typeof s.emoji === 'string' && s.emoji.length <= 16 && first(s.emoji) === s.emoji && /\p{Extended_Pictographic}/u.test(s.emoji);
const HOUR = 3600000;

export class Premium {
  loading = null; nextCatalogAttempt = 0;
  constructor(tg, ownerId, { state, save = () => {}, now = Date.now } = {}) {
    this.tg = tg; this.ownerId = Number(ownerId); this.save = save; this.now = now;
    const cached = state?.ownerId === this.ownerId ? state : {};
    this.state = { ownerId: this.ownerId, known: cached.known === true, userPremium: cached.userPremium === true,
      enabled: cached.enabled !== false, checkedAt: Number(cached.checkedAt) || 0, catalogAt: Number(cached.catalogAt) || 0,
      icons: Array.isArray(cached.icons) ? cached.icons.filter(validIcon).slice(0, 150) : [],
      customAllowed: typeof cached.customAllowed === 'boolean' ? cached.customAllowed : null,
      blockedUntil: Number(cached.blockedUntil) || 0, effectId: validId(cached.effectId) ? cached.effectId : null };
  }
  persist() { this.save(this.state); }
  recordUser(user) {
    if (user?.id !== this.ownerId || user.is_bot) return false;
    const premium = user.is_premium === true, changed = !this.state.known || premium !== this.state.userPremium;
    this.state.known = true; this.state.userPremium = premium;
    if (changed) { this.state.customAllowed = null; this.state.blockedUntil = 0; }
    if (changed || this.now() - this.state.checkedAt >= 300000) { this.state.checkedAt = this.now(); this.persist(); }
    return true;
  }
  observe(update) {
    if (!isPrivateOwner(update, this.ownerId)) return false;
    this.recordUser((update.callback_query || update.message).from);
    const message = update.message;
    if (this.state.userPremium && message && !message.forward_origin && !message.forward_from && !message.forward_from_chat && validId(message.effect_id) && message.effect_id !== this.state.effectId) {
      this.state.effectId = message.effect_id; this.persist();
    }
    return true;
  }
  async refresh(force = false) {
    if (force) { this.state.blockedUntil = 0; this.state.customAllowed = null; this.nextCatalogAttempt = 0; this.persist(); }
    try {
      const result = await this.tg.call('getChatMember', { chat_id: this.ownerId, user_id: this.ownerId });
      this.recordUser(result.user);
    } catch { /* User updates remain the authoritative fallback; no account login needed. */ }
    await this.prepare(); return this.state;
  }
  prepare() {
    if (this.loading) return this.loading;
    if (!this.state.userPremium || !this.state.enabled || (this.state.icons.length && this.now() - this.state.catalogAt < 24 * HOUR) || this.now() < this.nextCatalogAttempt) return Promise.resolve();
    this.nextCatalogAttempt = this.now() + HOUR;
    this.loading = (async () => {
      try {
        const stickers = await this.tg.call('getForumTopicIconStickers');
        if (!Array.isArray(stickers)) return;
        const icons = stickers.map(s => ({ emoji: s.emoji, id: s.custom_emoji_id })).filter(validIcon).slice(0, 150);
        if (icons.length) { this.state.icons = icons; this.state.catalogAt = this.now(); this.persist(); }
      } catch { /* Decorations are optional; continue plain message delivery. */ }
    })().finally(() => { this.loading = null; }); return this.loading;
  }
  icon(emoji) { return this.state.icons.find(s => normalize(s.emoji) === normalize(emoji)); }
  decorate(method, params) {
    if (Number(params.chat_id) !== this.ownerId || !this.state.userPremium || !this.state.enabled || !['sendMessage', 'editMessageText'].includes(method)) return params;
    let result = params;
    if (this.now() >= this.state.blockedUntil) {
      const prefix = first(params.text || ''), icon = this.icon(prefix);
      const protectedPrefix = params.entities?.some(e => ['pre', 'code'].includes(e.type) && e.offset === 0);
      if (icon && !protectedPrefix) {
        const delta = icon.emoji.length - prefix.length;
        const entities = (params.entities || []).map(e => ({ ...e,
          offset: e.offset >= prefix.length ? e.offset + delta : e.offset,
          length: e.offset === 0 && e.length >= prefix.length ? e.length + delta : e.length }));
        if (!entities.some(e => e.type === 'custom_emoji' && e.offset === 0)) entities.push({ type: 'custom_emoji', offset: 0, length: icon.emoji.length, custom_emoji_id: icon.id });
        result = { ...params, text: icon.emoji + params.text.slice(prefix.length), entities };
      }
      if (params.reply_markup?.inline_keyboard) {
        let changed = false;
        const inline_keyboard = params.reply_markup.inline_keyboard.map(row => row.map(button => {
          const prefix = first(button.text || ''), icon = this.icon(prefix), label = button.text?.slice(prefix.length).trimStart();
          if (!icon || !label) return button;
          changed = true; return { ...button, text: label, icon_custom_emoji_id: icon.id };
        }));
        if (changed) result = { ...result, reply_markup: { ...params.reply_markup, inline_keyboard } };
      }
    }
    // Reuse a received private-chat effect on short confirmation cards only.
    if (method === 'sendMessage' && this.state.effectId && /^(✅|📨)/u.test(params.text || '')) result = { ...result, message_effect_id: this.state.effectId };
    return result;
  }
  async deliver(method, params) {
    const decorated = this.decorate(method, params);
    try {
      const result = await this.tg.call(method, decorated);
      const hasCustom = decorated.entities?.some(e => e.type === 'custom_emoji') || decorated.reply_markup?.inline_keyboard?.flat().some(b => b.icon_custom_emoji_id);
      if (decorated !== params && hasCustom && result) {
        const accepted = Boolean(result.entities?.some(e => e.type === 'custom_emoji') || result.reply_markup?.inline_keyboard?.flat().some(b => b.icon_custom_emoji_id));
        if (this.state.customAllowed !== accepted || (!accepted && this.now() >= this.state.blockedUntil)) { this.state.customAllowed = accepted; this.state.blockedUntil = accepted ? 0 : this.now() + HOUR; this.persist(); }
      }
      return result;
    } catch (error) {
      // Retry only an explicit cosmetic validation rejection. Network/429/5xx
      // outcomes are never replayed, and no model/account operation is retried.
      if (decorated === params || error?.errorCode !== 400 || !/custom.?emoji|emoji.*not.*allowed|BUTTON_TYPE_INVALID|DOCUMENT_INVALID|effect.*invalid|invalid.*effect|EFFECT_NOT_ALLOWED/i.test(error.message)) throw error;
      if (/effect/i.test(error.message) && decorated.message_effect_id) this.state.effectId = null;
      else { this.state.customAllowed = false; this.state.blockedUntil = this.now() + HOUR; }
      this.persist(); return this.tg.call(method, params);
    }
  }
  async toggle() { this.state.enabled = !this.state.enabled; this.persist(); await this.prepare(); }
}
