// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { Premium } from './premium.mjs';
import { card } from './format.mjs';
import { text as T } from './premium-text.mjs';
export class PremiumUi {
  constructor(bridge) { this.bridge = bridge; this.profile = bridge.premium || new Premium(bridge.tg, bridge.chatId); }
  async show(refresh = false) {
    if (refresh) await this.profile.refresh(true);
    const s = this.profile.state;
    return this.bridge.tg.send(this.bridge.chatId, card(T.title, `${T.account}: ${!s.known ? T.unknown : s.userPremium ? T.premium : T.standard}\n${T.appearance}: ${s.enabled ? T.enabled : T.disabled}\n${T.permission}: ${s.customAllowed === null ? T.checking : s.customAllowed ? T.available : T.unavailable}\n${T.effect}: ${s.userPremium && s.enabled && s.effectId ? T.enabled : T.none}\n\n${T.details}`), {
      inline_keyboard: [[{ text: T.refresh, callback_data: 'u:premium-refresh' }, { text: s.enabled ? T.disable : T.enable, callback_data: 'u:premium-toggle' }], [{ text: T.home, callback_data: 'u:home' }]],
    });
  }
  async toggle() { await this.profile.toggle(); return this.show(); }
}
