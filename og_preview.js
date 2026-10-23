/**
 * ==============================================================================
 * OpenGraph Dynamic Meta Preview Generator for Social Media Crawlers (NJS)
 * ==============================================================================
 * Intercepts requests from Facebook, Telegram, WhatsApp, Twitter, LinkedIn, etc.,
 * queries the backend API for dynamic metadata (titles, images, descriptions),
 * and returns pre-rendered OpenGraph HTML cards.
 *
 * Environment Detection:
 * - Production: https://apinlebiclosha.utebi.com
 * - QA:         https://qacltom.udaya-tech.com
 * Can also be overridden in nginx.conf using:
 *   set $og_api_base "https://apinlebiclosha.utebi.com";
 *   or:
 *   set $api_env "production"; # or "qa"
 */

function getApiBaseUrl(r, host) {
    // 1. Explicit Nginx variable override ($og_api_base)
    if (r.variables && r.variables.og_api_base) {
        return r.variables.og_api_base.replace(/\/+$/, '');
    }

    // 2. Explicit environment variable override ($api_env)
    var env = (r.variables && r.variables.api_env) || '';
    if (env.toLowerCase() === 'qa') {
        return 'https://qacltom.udaya-tech.com';
    }
    if (env.toLowerCase() === 'prod' || env.toLowerCase() === 'production') {
        return 'https://apinlebiclosha.utebi.com';
    }

    // 3. Explicit Production domains
    var h = (host || '').toLowerCase();
    if (h.includes('visitangkor.utebi.com')) {
        return 'https://apinlebiclosha.utebi.com';
    }

    // 4. Only use QA if the hostname explicitly specifies QA
    if (h.includes('qacltom') || h.includes('qa-visitangkor')) {
        return 'https://qacltom.udaya-tech.com';
    }

    // 5. Default to Production API (https://apinlebiclosha.utebi.com)
    return 'https://apinlebiclosha.utebi.com';
}

async function handleBotPreview(r) {
    var uri = r.variables.request_uri || r.uri;

    // Ignore static asset files if requested directly by bots (e.g. css, js, images)
    if (uri.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|map|json)$/i)) {
        r.return(404);
        return;
    }

    var host = r.headersIn['host'] || (r.variables && r.variables.host) || 'localhost';
    var proto = r.headersIn['x-forwarded-proto'] || (r.variables && r.variables.scheme) || 'https';
    var origin = proto + '://' + host;
    var pageUrl = origin + uri;

    var apiBase = getApiBaseUrl(r, host);

    var hasPrefix = uri.startsWith('/visit-angkor');
    var fallbackImg = hasPrefix ? '/visit-angkor/assets/apsara.png' : '/assets/apsara.png';

    var title = 'Apsara | Visit Angkor';
    var description = 'Explore temples and events around Angkor.';
    var imageUrl = origin + fallbackImg;

    try {
        var templeMatch = uri.match(/\/temple\/detail\/([^\/\?]+)/);
        var moreThanMatch = uri.match(/\/(activity|event|annual_event|community|museum|other)\/detail\/([^\/\?]+)/);
        var audioMatch = uri.match(/\/audio\/([^\/\?]+)/);

        ngx.log(ngx.WARN, 'NJS Bot Handler [' + apiBase + '] URI: ' + uri + ' | temple: ' + (templeMatch ? templeMatch[1] : 'none'));

        // 1. Temple Details
        if (templeMatch) {
            var templeId = templeMatch[1];
            var apiRes = await ngx.fetch(apiBase + '/visitAngkorMobileAPi/temple/find/' + templeId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                verify: false
            });

            if (apiRes.status === 200) {
                var json = await apiRes.json();
                var data = (json.body && json.body.data) ? json.body.data : (json.data || json);
                var item = (Array.isArray(data) && data.length > 0) ? data[0] : data;

                if (item && item.nameKh) {
                    title = item.nameKh.trim() + ' | Visit Angkor';
                }
                var thumb = item.thumbnail || item.slide || '';
                if (thumb) {
                    var fullImgUrl = thumb.startsWith('http') ? thumb : apiBase + '/visitAngkorWebAPi' + thumb;
                    imageUrl = encodeURI(fullImgUrl);
                }
                var histPath = item.historyKh || (item.templeHistoryResponses && item.templeHistoryResponses[0] ? item.templeHistoryResponses[0].historyKh : '');
                if (histPath) {
                    var fullHistUrl = histPath.startsWith('http') ? histPath : apiBase + '/visitAngkorWebAPi' + histPath;
                    try {
                        var hRes = await ngx.fetch(fullHistUrl, { verify: false });
                        if (hRes.status === 200) {
                            var hText = await hRes.text();
                            var plain = hText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                            if (plain) {
                                description = plain.length > 200 ? plain.substring(0, 197) + '...' : plain;
                            }
                        }
                    } catch (he) {}
                }
            }
        // 2. Activities, Events, Communities, Museums, Other
        } else if (moreThanMatch) {
            var type = moreThanMatch[1];
            var itemId = moreThanMatch[2];
            var apiRes = await ngx.fetch(apiBase + '/visitAngkorMobileAPi/more-than-temple-type/find-item/' + type + '/' + itemId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                verify: false
            });

            if (apiRes.status === 200) {
                var json = await apiRes.json();
                var data = (json.body && json.body.data) ? json.body.data : (json.data || json);
                var item = (Array.isArray(data) && data.length > 0) ? data[0] : data;
                var nameVal = (item.nameKh || item.nameEn || '').trim();
                if (nameVal) {
                    title = nameVal + ' | Visit Angkor';
                }
                var thumb = item.thumbnail || item.slide || '';
                if (thumb) {
                    var fullImgUrl = thumb.startsWith('http') ? thumb : apiBase + '/visitAngkorWebAPi' + thumb;
                    imageUrl = encodeURI(fullImgUrl);
                }
                var descPath = item.descriptionKh || item.descriptionEn || '';
                if (descPath) {
                    var fullDescUrl = descPath.startsWith('http') ? descPath : apiBase + '/visitAngkorWebAPi' + descPath;
                    try {
                        var dRes = await ngx.fetch(fullDescUrl, { verify: false });
                        if (dRes.status === 200) {
                            var dText = await dRes.text();
                            var plain = dText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                            if (plain) {
                                description = plain.length > 200 ? plain.substring(0, 197) + '...' : plain;
                            }
                        }
                    } catch (de) {}
                }
            }
        // 3. Audio Guide
        } else if (audioMatch) {
            var nanoId = audioMatch[1];
            var apiRes = await ngx.fetch(apiBase + '/visitAngkorMobileAPi/museum/public/audio-guide/' + nanoId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                verify: false
            });

            if (apiRes.status === 200) {
                var json = await apiRes.json();
                var data = (json.body && json.body.data) ? json.body.data : (json.data || json);
                var item = (Array.isArray(data) && data.length > 0) ? data[0] : data;
                if (item && item.name) {
                    title = item.name.trim() + ' | Visit Angkor';
                }
                if (item && item.imageUrl) {
                    var fullImgUrl = item.imageUrl.startsWith('http') ? item.imageUrl : apiBase + '/visitAngkorWebAPi' + item.imageUrl;
                    imageUrl = encodeURI(fullImgUrl);
                }
            }
        }
    } catch (e) {
        ngx.log(ngx.ERR, 'NJS Bot Preview Exception: ' + e + ' | ' + (e.stack || ''));
    }

    var fbAppId = (r.variables && r.variables.fb_app_id) || '';
    var fbAppMeta = fbAppId ? '    <meta property="fb:app_id" content="' + fbAppId + '" />\n' : '';

    var html = '<!DOCTYPE html>\n' +
        '<html lang="en">\n' +
        '  <head>\n' +
        '    <meta charset="utf-8" />\n' +
        '    <title>' + title + '</title>\n' +
        '    <meta name="description" content="' + description + '" />\n' +
        fbAppMeta +
        '    <meta property="og:type" content="website" />\n' +
        '    <meta property="og:site_name" content="Apsara | Visit Angkor" />\n' +
        '    <meta property="og:locale" content="km_KH" />\n' +
        '    <meta property="og:title" content="' + title + '" />\n' +
        '    <meta property="og:description" content="' + description + '" />\n' +
        '    <meta property="og:url" content="' + pageUrl + '" />\n' +
        '    <meta property="og:image" content="' + imageUrl + '" />\n' +
        '    <meta property="og:image:width" content="1200" />\n' +
        '    <meta property="og:image:height" content="630" />\n' +
        '    <meta name="twitter:card" content="summary_large_image" />\n' +
        '    <meta name="twitter:title" content="' + title + '" />\n' +
        '    <meta name="twitter:description" content="' + description + '" />\n' +
        '    <meta name="twitter:image" content="' + imageUrl + '" />\n' +
        '  </head>\n' +
        '  <body>\n' +
        '    <script>window.location.href = "' + pageUrl + '";</script>\n' +
        '  </body>\n' +
        '</html>';

    r.headersOut['Content-Type'] = 'text/html; charset=UTF-8';
    r.return(200, html);
}

export default { handleBotPreview };
