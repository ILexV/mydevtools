//! Cookie jar of the HTTP client (RFC 6265 with the 6265bis Secure rules).
//! The page owns the jar and sends it with a request; the agent picks the
//! cookies for every hop, applies `Set-Cookie` of every hop (so a login 302
//! that sets a session reaches the next hop) and returns what changed.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, header::SET_COOKIE};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::model::ApiError;

pub(crate) const MAX_COOKIES: usize = 300;
/// Name and value together, as browsers cap a cookie.
const MAX_COOKIE_BYTES: usize = 4096;
const MAX_JAR_BYTES: usize = 256 * 1024;
const MAX_SET_COOKIES_PER_RESPONSE: usize = 50;
const MAX_PATH_BYTES: usize = 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Cookie {
    pub(crate) name: String,
    pub(crate) value: String,
    /// Lowercase, without a leading dot.
    pub(crate) domain: String,
    pub(crate) path: String,
    /// Sent only to `domain` itself, not its subdomains (no Domain attribute).
    #[serde(default)]
    pub(crate) host_only: bool,
    #[serde(default)]
    pub(crate) secure: bool,
    #[serde(default)]
    pub(crate) http_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) same_site: Option<String>,
    /// Unix seconds; none is a session cookie. A change with an expiry in the
    /// past tells the page to delete the cookie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expires: Option<i64>,
}

impl Cookie {
    fn same_key(&self, other: &Self) -> bool {
        self.name == other.name && self.domain == other.domain && self.path == other.path
    }

    fn bytes(&self) -> usize {
        self.name.len() + self.value.len() + self.domain.len() + self.path.len()
    }

    fn expired(&self, now: i64) -> bool {
        self.expires.is_some_and(|expires| expires <= now)
    }

    fn removal(&self) -> Self {
        Self {
            expires: Some(0),
            ..self.clone()
        }
    }
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        })
}

/// The request-local jar: what the page sent plus every change made by the hops.
#[derive(Debug)]
pub(crate) struct Jar {
    cookies: Vec<Cookie>,
    changes: Vec<Cookie>,
}

impl Jar {
    pub(crate) fn new(cookies: Vec<Cookie>) -> Result<Self, ApiError> {
        let valid = cookies.len() <= MAX_COOKIES
            && cookies.iter().map(Cookie::bytes).sum::<usize>() <= MAX_JAR_BYTES
            && cookies.iter().all(|cookie| {
                !cookie.name.is_empty()
                    && cookie.name.len() + cookie.value.len() <= MAX_COOKIE_BYTES
                    && valid_name(&cookie.name)
                    && valid_value(&cookie.value)
                    && !cookie.domain.is_empty()
                    && cookie.domain.len() <= 253
                    && cookie.domain == cookie.domain.to_ascii_lowercase()
                    && !cookie.domain.starts_with('.')
                    && cookie.path.starts_with('/')
                    && cookie.path.len() <= MAX_PATH_BYTES
                    && valid_value(&cookie.path)
            });
        if !valid {
            return Err(ApiError::invalid_request());
        }
        Ok(Self {
            cookies,
            changes: Vec::new(),
        })
    }

    /// The `Cookie` header value for a hop, longest paths first.
    pub(crate) fn header(&self, url: &Url, now: i64) -> Option<String> {
        let host = request_host(url)?;
        let secure = url.scheme() == "https";
        let path = url.path();
        let mut matching: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|cookie| {
                !cookie.expired(now)
                    && (secure || !cookie.secure)
                    && domain_matches(cookie, &host, url)
                    && path_matches(path, &cookie.path)
            })
            .collect();
        if matching.is_empty() {
            return None;
        }
        matching.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
        Some(
            matching
                .iter()
                .map(|cookie| format!("{}={}", cookie.name, cookie.value))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    /// Applies the hop's `Set-Cookie` headers; malformed or disallowed ones are ignored like a browser does.
    pub(crate) fn store(&mut self, url: &Url, headers: &HeaderMap, now: i64) {
        for value in headers
            .get_all(SET_COOKIE)
            .iter()
            .take(MAX_SET_COOKIES_PER_RESPONSE)
        {
            let Ok(text) = value.to_str() else { continue };
            if let Some(cookie) = parse_set_cookie(text, url, now) {
                self.apply(cookie, now);
            }
        }
    }

    fn apply(&mut self, cookie: Cookie, now: i64) {
        let existing = self
            .cookies
            .iter()
            .position(|stored| stored.same_key(&cookie));
        if cookie.expired(now) {
            if let Some(index) = existing {
                let removed = self.cookies.remove(index);
                self.record(removed.removal());
            }
            return;
        }
        match existing {
            Some(index) => self.cookies[index] = cookie.clone(),
            None => {
                self.cookies.retain(|stored| !stored.expired(now));
                while self.cookies.len() >= MAX_COOKIES
                    || self.cookies.iter().map(Cookie::bytes).sum::<usize>() + cookie.bytes()
                        > MAX_JAR_BYTES
                {
                    // The oldest cookie makes room, as browsers evict.
                    let evicted = self.cookies.remove(0);
                    self.record(evicted.removal());
                }
                self.cookies.push(cookie.clone());
            }
        }
        self.record(cookie);
    }

    fn record(&mut self, change: Cookie) {
        self.changes.retain(|recorded| !recorded.same_key(&change));
        self.changes.push(change);
    }

    pub(crate) fn into_changes(self) -> Vec<Cookie> {
        self.changes
    }
}

/// Lowercase host without IPv6 brackets.
fn request_host(url: &Url) -> Option<String> {
    Some(
        url.host_str()?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase(),
    )
}

fn is_ip(url: &Url) -> bool {
    matches!(url.host(), Some(Host::Ipv4(_) | Host::Ipv6(_)))
}

fn domain_matches(cookie: &Cookie, host: &str, url: &Url) -> bool {
    if cookie.host_only || is_ip(url) {
        return host == cookie.domain;
    }
    host == cookie.domain
        || host.len() > cookie.domain.len()
            && host.ends_with(&cookie.domain)
            && host.as_bytes()[host.len() - cookie.domain.len() - 1] == b'.'
}

fn path_matches(request: &str, cookie: &str) -> bool {
    request == cookie
        || request.starts_with(cookie)
            && (cookie.ends_with('/') || request.as_bytes().get(cookie.len()) == Some(&b'/'))
}

/// RFC 6265 5.1.4: the request path up to, not including, its last `/`.
fn default_path(url: &Url) -> String {
    let path = url.path();
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(index) => path[..index].to_owned(),
    }
}

fn valid_name(name: &str) -> bool {
    name.bytes()
        .all(|byte| byte.is_ascii_graphic() && !b"()<>@,;:\\\"/[]?={}".contains(&byte))
}

/// No controls, no `;`; spaces inside are kept as browsers do.
fn valid_value(value: &str) -> bool {
    !value.chars().any(|ch| ch.is_control() || ch == ';')
}

fn parse_set_cookie(text: &str, url: &Url, now: i64) -> Option<Cookie> {
    let mut parts = text.split(';');
    let (name, value) = parts.next()?.split_once('=')?;
    let (name, value) = (name.trim(), value.trim());
    if name.is_empty()
        || name.len() + value.len() > MAX_COOKIE_BYTES
        || !valid_name(name)
        || !valid_value(value)
    {
        return None;
    }
    let host = request_host(url)?;
    let mut expires = None;
    let mut max_age = None;
    let mut domain = None;
    let mut path = None;
    let mut secure = false;
    let mut http_only = false;
    let mut same_site = None;
    for attribute in parts {
        let (key, attribute_value) = attribute
            .split_once('=')
            .map_or((attribute, ""), |(key, value)| (key, value));
        let attribute_value = attribute_value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "expires" => expires = parse_cookie_date(attribute_value).or(expires),
            "max-age" => max_age = parse_max_age(attribute_value, now).or(max_age),
            "domain" if !attribute_value.is_empty() => {
                domain = Some(attribute_value.trim_start_matches('.').to_ascii_lowercase());
            }
            "path" => {
                path = (attribute_value.starts_with('/')
                    && attribute_value.len() <= MAX_PATH_BYTES)
                    .then(|| attribute_value.to_owned());
            }
            "secure" => secure = true,
            "httponly" => http_only = true,
            "samesite" => {
                same_site = match attribute_value.to_ascii_lowercase().as_str() {
                    "strict" => Some("Strict".to_owned()),
                    "lax" => Some("Lax".to_owned()),
                    "none" => Some("None".to_owned()),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    if secure && url.scheme() != "https" {
        return None;
    }
    let (domain, host_only) = match domain {
        None => (host.clone(), true),
        Some(domain) if is_ip(url) || !domain.contains('.') => {
            // An IP or a single label (localhost, a public suffix) is never shared.
            if domain != host {
                return None;
            }
            (host.clone(), true)
        }
        Some(domain) => {
            let cookie = Cookie {
                name: String::new(),
                value: String::new(),
                domain: domain.clone(),
                path: String::new(),
                host_only: false,
                secure,
                http_only,
                same_site: None,
                expires: None,
            };
            if !domain_matches(&cookie, &host, url) {
                return None;
            }
            (domain, false)
        }
    };
    let path = path.unwrap_or_else(|| default_path(url));
    if name.starts_with("__Secure-") && !secure
        || name.starts_with("__Host-") && (!secure || !host_only || path != "/")
    {
        return None;
    }
    Some(Cookie {
        name: name.to_owned(),
        value: value.to_owned(),
        domain,
        path,
        host_only,
        secure,
        http_only,
        same_site,
        expires: max_age.or(expires),
    })
}

/// Max-Age wins over Expires; zero or negative expires at once.
fn parse_max_age(value: &str, now: i64) -> Option<i64> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if value.starts_with('-') {
        return Some(0);
    }
    let seconds = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if seconds == 0 {
        0
    } else {
        now.saturating_add(seconds)
    })
}

/// RFC 6265 5.1.1 date parsing: tolerant of the formats servers really send
/// (`Wed, 21 Oct 2015 07:28:00 GMT`, `Wed, 21-Oct-15 07:28:00 GMT`, asctime).
fn parse_cookie_date(text: &str) -> Option<i64> {
    let delimiter = |ch: char| matches!(ch, '\t' | ' '..='/' | ';'..='@' | '['..='`' | '{'..='~');
    let (mut time, mut day, mut month, mut year) = (None, None, None, None);
    for token in text.split(delimiter).filter(|token| !token.is_empty()) {
        if time.is_none() {
            if let Some(parsed) = parse_time(token) {
                time = Some(parsed);
                continue;
            }
        }
        if day.is_none() {
            if let Some(parsed) = leading_digits(token, 1, 2) {
                day = Some(parsed);
                continue;
            }
        }
        if month.is_none() {
            if let Some(parsed) = parse_month(token) {
                month = Some(parsed);
                continue;
            }
        }
        if year.is_none() {
            if let Some(parsed) = leading_digits(token, 2, 4) {
                year = Some(parsed);
            }
        }
    }
    let (hour, minute, second) = time?;
    let (day, month, mut year) = (day?, month?, year?);
    if (70..=99).contains(&year) {
        year += 1900;
    } else if year <= 69 {
        year += 2000;
    }
    let days_in_month = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if year < 1601 || day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
    Some(days * 86_400 + i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second))
}

/// `min..=max` leading digits followed by a non-digit or the end.
fn leading_digits(token: &str, min: usize, max: usize) -> Option<u32> {
    let count = token.bytes().take_while(u8::is_ascii_digit).count();
    (min..=max)
        .contains(&count)
        .then(|| token[..count].parse().ok())?
}

fn parse_time(token: &str) -> Option<(u32, u32, u32)> {
    let mut parts = token.splitn(3, ':');
    let hour = parts.next()?;
    let minute = parts.next()?;
    let second = parts.next()?;
    let whole = |part: &str| {
        (1..=2).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !whole(hour) || !whole(minute) {
        return None;
    }
    Some((
        hour.parse().ok()?,
        minute.parse().ok()?,
        leading_digits(second, 1, 2)?,
    ))
}

fn parse_month(token: &str) -> Option<u32> {
    let prefix = token.get(..3)?.to_ascii_lowercase();
    let index = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|month| *month == prefix)?;
    u32::try_from(index + 1).ok()
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    const NOW: i64 = 1_760_000_000;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn set(jar: &mut Jar, at: &str, values: &[&str]) {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(SET_COOKIE, HeaderValue::from_str(value).unwrap());
        }
        jar.store(&url(at), &headers, NOW);
    }

    #[test]
    fn dates_follow_the_rfc_algorithm() {
        assert_eq!(
            parse_cookie_date("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(1_445_412_480)
        );
        assert_eq!(
            parse_cookie_date("Wed, 21-Oct-15 07:28:00 GMT"),
            Some(1_445_412_480)
        );
        assert_eq!(
            parse_cookie_date("Wed Oct 21 07:28:00 2015"),
            Some(1_445_412_480)
        );
        assert_eq!(parse_cookie_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(
            parse_cookie_date("29 Feb 2024 12:00:00"),
            Some(1_709_208_000)
        );
        assert_eq!(parse_cookie_date("30 Feb 2024 12:00:00"), None);
        assert_eq!(parse_cookie_date("Wed, 21 Oct 2015 25:28:00 GMT"), None);
        assert_eq!(parse_cookie_date("tomorrow"), None);
    }

    #[test]
    fn domain_path_and_secure_rules_pick_cookies_per_url() {
        let mut jar = Jar::new(Vec::new()).unwrap();
        set(
            &mut jar,
            "https://api.example.com/v1/login",
            &[
                "host=1",
                "shared=2; Domain=.Example.com; Path=/",
                "deep=3; Path=/v1/users",
                "safe=4; Secure; HttpOnly; SameSite=lax",
                "evil=5; Domain=other.com",
                "suffix=6; Domain=com",
            ],
        );
        assert_eq!(
            jar.header(&url("https://api.example.com/v1/users/7"), NOW)
                .as_deref(),
            Some("deep=3; host=1; safe=4; shared=2")
        );
        assert_eq!(
            jar.header(&url("http://www.example.com/"), NOW).as_deref(),
            Some("shared=2")
        );
        assert_eq!(
            jar.header(&url("https://api.example.com/v1x"), NOW)
                .as_deref(),
            Some("shared=2")
        );
        assert_eq!(jar.header(&url("https://other.com/"), NOW), None);
        let changes = jar.into_changes();
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].path, "/v1");
        assert!(changes[0].host_only);
        assert_eq!(changes[1].domain, "example.com");
        assert!(!changes[1].host_only);
        assert_eq!(changes[3].same_site.as_deref(), Some("Lax"));
        assert!(changes[3].http_only && changes[3].secure);
    }

    #[test]
    fn expiry_replacement_deletion_and_prefixes() {
        let session = Cookie {
            name: "sid".to_owned(),
            value: "old".to_owned(),
            domain: "127.0.0.1".to_owned(),
            path: "/".to_owned(),
            host_only: true,
            secure: false,
            http_only: false,
            same_site: None,
            expires: None,
        };
        let mut jar = Jar::new(vec![session.clone()]).unwrap();
        assert_eq!(
            jar.header(&url("http://127.0.0.1:8080/x"), NOW).as_deref(),
            Some("sid=old")
        );
        set(
            &mut jar,
            "http://127.0.0.1:8080/x",
            &[
                "sid=new; Path=/; Max-Age=60",
                "gone=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
                "secure=1; Secure",
                "__Host-id=1; Path=/",
                "ip=1; Domain=0.0.1",
            ],
        );
        assert_eq!(
            jar.header(&url("http://127.0.0.1:8080/"), NOW).as_deref(),
            Some("sid=new")
        );
        assert_eq!(jar.header(&url("http://127.0.0.1:8080/"), NOW + 61), None);
        set(
            &mut jar,
            "http://127.0.0.1:8080/",
            &["sid=; Path=/; Max-Age=0"],
        );
        assert_eq!(jar.header(&url("http://127.0.0.1:8080/"), NOW), None);
        let changes = jar.into_changes();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].expires, Some(0));
        assert_eq!(changes[0].name, "sid");

        let mut jar = Jar::new(Vec::new()).unwrap();
        set(
            &mut jar,
            "https://example.com/a/b",
            &[
                "__Host-id=1; Secure; Path=/",
                "__Secure-x=1",
                "local=1; Domain=localhost",
            ],
        );
        let names: Vec<String> = jar
            .into_changes()
            .into_iter()
            .map(|cookie| cookie.name)
            .collect();
        assert_eq!(names, ["__Host-id"]);
    }

    #[test]
    fn the_jar_is_bounded_and_validated() {
        let cookie = |index: usize| Cookie {
            name: format!("c{index}"),
            value: "v".to_owned(),
            domain: "example.com".to_owned(),
            path: "/".to_owned(),
            host_only: true,
            secure: false,
            http_only: false,
            same_site: None,
            expires: None,
        };
        assert!(Jar::new((0..=MAX_COOKIES).map(cookie).collect()).is_err());
        assert!(
            Jar::new(vec![Cookie {
                value: "a;b".to_owned(),
                ..cookie(0)
            }])
            .is_err()
        );
        assert!(
            Jar::new(vec![Cookie {
                domain: ".example.com".to_owned(),
                ..cookie(0)
            }])
            .is_err()
        );
        let mut jar = Jar::new((0..MAX_COOKIES).map(cookie).collect()).unwrap();
        set(&mut jar, "http://example.com/", &["fresh=1"]);
        let changes = jar.into_changes();
        assert_eq!(changes.len(), 2);
        assert_eq!(
            (changes[0].name.as_str(), changes[0].expires),
            ("c0", Some(0))
        );
        assert_eq!(changes[1].name, "fresh");
    }
}
