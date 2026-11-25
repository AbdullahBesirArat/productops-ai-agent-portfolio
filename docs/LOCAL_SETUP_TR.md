# Windows PowerShell ile yerel kurulum

Node.js 24, npm ve Docker Compose kullanın. Tarayıcı testleri için sistem Chrome gerekir. Komutları depo kökünde çalıştırın.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local -ErrorAction Stop # Yalnızca ilk kurulumda
```

Mevcut `.env.local` dosyasını koruyun ve yukarıdaki kopyalama adımını atlayın. Şablondaki gerekli değerleri yerel olarak doldurun. Uygulama, auth, migrator ve bootstrap bağlantılarında ayrı roller kullanın. URL parola bileşenini gerektiğinde yüzde kodlamasıyla yazın. İstek özeti için 32 baytlık sabit rastgele hex anahtar kullanın. Dosyayı veya kimlik bilgilerini paylaşmayın. [Ortam şablonu](../.env.example)

```powershell
docker compose --env-file .env.local up -d
docker compose --env-file .env.local port productops-db 5432
npm.cmd run db:setup
npm.cmd run demo
```

API ve arayüz varsayılan olarak `127.0.0.1:3108`, auth süreci `127.0.0.1:3109` üzerindedir. Tarayıcıda http://127.0.0.1:3108/ui adresini açın. Compose varsayılan DB bağlantı noktası `127.0.0.1:54329`, alternatif yerel bağlantı noktası olarak `127.0.0.1:54330` kullanılabilir. Yerel `PRODUCTOPS_DB_PORT` ve DB URL bağlantı noktaları eşleşmelidir. [Compose](../docker-compose.yml)

- Port doluysa `Get-NetTCPConnection -LocalPort 3108,3109` ile dinleyiciyi inceleyin. Gerekirse `PORT` ve `PRODUCTOPS_AUTH_PORT` değerlerini değiştirip yeniden başlatın.
- Eski volume üzerinde auth rolü eksikse PostgreSQL hazır olduktan sonra `docker compose --env-file .env.local exec -T productops-db bash /docker-entrypoint-initdb.d/03-auth-service-role.sh` çalıştırın. Yeni ortam değerlerinin konteynere yansıdığını kontrol edin ve volume'u koruyun.
- Başlangıç hatasında auth ve uygulama URL'lerini, yerel DB portunu ve özet anahtarını dosyayı ekrana yazdırmadan kontrol edin. Yeniden başlatma geçici imzalama anahtarını değiştirir. Yeniden giriş yapın.
- Durdurmak için demo terminalinde Ctrl+C kullanın. Ardından `docker compose --env-file .env.local stop` komutuyla DB'yi durdurun. [Demo akışı](portfolio/DEMO_RUNBOOK.md)
