# نصب ربات سرور و رابط ویندوز

توسعه‌دهنده: **Mohsen Zamani / ZamaniDeveloper**. [مجوز](../LICENSE) را در
بازنشر حفظ کن. [راهنمای انگلیسی با تمام دستورات سرور](INSTALL.en.md).

## اجرای محلی سریع

ویندوز، Codex واردشده، Node.js 24.17.0+ و PowerShell 7.3+ لازم‌اند:

```powershell
git clone https://github.com/ZamaniDeveloper/telegram-codex-remote.git
cd telegram-codex-remote
npm ci --ignore-scripts
.\setup.ps1
npm start
```

توکن BotFather مخفی دریافت می‌شود. کد `/pair ...` ترمینال را در چت خصوصی ربات
بفرست و از «چت‌ها» مقصد را انتخاب کن. اگر ربات روی سرور است، دریافت‌کنندهٔ محلی
را هم‌زمان اجرا نکن.

## ربات روی سرور

۱. روی Linux دارای Node.js پروژه را کلون کن. مطابق
[مرحلهٔ ۲](INSTALL.en.md#2-prepare-dedicated-server-accounts)، حساب سرویس ربات
و حساب جدا برای تونل بساز. تنظیم PM2 مسیر پروژه و Node را تشخیص می‌دهد.

۲. اثرانگشت معتبر کلید میزبان را در کنسول سرور بخوان:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

۳. روی ویندوز تنظیم‌کننده را اجرا کن:

```powershell
.\setup-connector.ps1 -SshHost server.example.com -SshUser codexbridge -SshPort 22
```

اثر انگشت `SHA256:...` مرحلهٔ قبل را وارد کن. تطبیق‌نداشتن آن نصب را متوقف
می‌کند. اسکریپت کلید جدا، secret تصادفی، `.connector.env`، کلید میزبان و
`data/server.env.generated` را می‌سازد. **کلید خصوصی را به سرور نفرست.**

۴. مدیر سرور کلید **عمومی** را با محدودیت‌های
[مرحلهٔ ۴](INSTALL.en.md#4-restrict-the-ssh-tunnel-key) نصب کند. فقط reverse
forward به loopback مجاز باشد. قبل از reload تنظیم SSH با `sshd -t` بررسی شود.

۵. فایل خصوصی `data/server.env.generated` را از اتصال امن مدیر به `.env` سرور
منتقل کن، توکن BotFather را وارد و مجوز ۶۰۰ را تنظیم کن. طبق
[مرحلهٔ ۵](INSTALL.en.md#5-configure-and-start-the-bot-service)، همین ربات را
زیر PM2 اجرا کن، `pm2 save` بزن و سرویس boot را فعال و بررسی کن.

۶. پس از آماده‌شدن سرور، روی ویندوز اجرا کن:

```powershell
.\install-windows.ps1
```

اگر تنظیمات وجود نداشته باشد، نصب‌کننده ابتدا تنظیم اولیه را انجام می‌دهد و برای
آماده‌کردن سرور متوقف می‌شود؛ سپس دوباره اجراش کن. اجرای خودکار بعد از **ورود
کاربر به ویندوز** انجام می‌شود و رمز ویندوز ذخیره نمی‌شود.

۷. کد جفت‌سازی را از لاگ خصوصی سرویس بخوان و در ربات بفرست؛ سپس چت را انتخاب
کن. کلیدها، secret، کد جفت‌سازی و لاگ خام را در GitHub منتشر نکن.

## به‌روزرسانی و حذف اجرای خودکار

از تنظیمات، کلیدها و `data/` پشتیبان بگیر. روی سرور فقط همین ربات را متوقف،
به‌روز، بررسی و دوباره اجرا کن. روی ویندوز:

```powershell
.\uninstall-autostart.ps1
git pull --ff-only
npm ci --ignore-scripts
npm run verify
.\install-windows.ps1
```

حذف اجرای خودکار فایل‌ها یا Codex را حذف نمی‌کند. پیوست‌ها تا زمانی که چت به
آن‌ها نیاز دارد باید باقی بمانند. `npm run doctor` فقط کاتالوگ و snapshot را
می‌خواند و پیام برای مدل نمی‌فرستد.

در قطع رابط، روشن‌بودن سیستم، ورود کاربر، Task و کلید SSH را بررسی کن. دکمهٔ
قدیمی را از منوی تازه باز کن. برای ریست نامشخص از دکمهٔ بررسی همان درخواست
استفاده کن و journal را پاک نکن. پس از آپدیت Codex، `doctor` را با چت باز اجرا کن.

[امنیت](../SECURITY.md) · [حدود قابلیت](../README.md#سازگاری-و-حدود-قابلیت)
