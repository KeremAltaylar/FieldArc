/* Just enough JSON to read a feature's patch and rhythm (main thread only). */
#pragma once
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

struct Json {
    enum Kind { NUL, BOOL, NUM, STR, ARR, OBJ } kind = NUL;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<Json> arr;
    std::vector<std::pair<std::string, Json>> obj;

    const Json *get(const char *k) const {
        if (kind != OBJ) return nullptr;
        for (auto &p : obj) if (p.first == k) return &p.second;
        return nullptr;
    }
    const Json *at(size_t i) const { return kind == ARR && i < arr.size() ? &arr[i] : nullptr; }
    size_t size() const { return kind == ARR ? arr.size() : 0; }
    /* the JS reads: a missing key or the wrong type falls back */
    double n(const char *k, double def) const { const Json *j = get(k); return j && j->kind == NUM ? j->num : def; }
    bool flag(const char *k, bool def) const { const Json *j = get(k); return j ? (j->kind == BOOL ? j->b : (j->kind == NUM ? j->num != 0 : (j->kind != NUL))) : def; }
    std::string s(const char *k, const char *def) const { const Json *j = get(k); return j && j->kind == STR ? j->str : def; }

    static Json parse(const char *text) { const char *p = text; Json j; if (text) value(p, j); return j; }

private:
    static void ws(const char *&p) { while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') p++; }
    static bool value(const char *&p, Json &out) {
        ws(p);
        if (*p == '{') {
            p++; out.kind = OBJ; ws(p);
            if (*p == '}') { p++; return true; }
            for (;;) {
                ws(p); Json key;
                if (*p != '"' || !value(p, key)) return false;
                ws(p); if (*p != ':') return false; p++;
                Json v; if (!value(p, v)) return false;
                out.obj.emplace_back(key.str, std::move(v));
                ws(p);
                if (*p == ',') { p++; continue; }
                if (*p == '}') { p++; return true; }
                return false;
            }
        }
        if (*p == '[') {
            p++; out.kind = ARR; ws(p);
            if (*p == ']') { p++; return true; }
            for (;;) {
                Json v; if (!value(p, v)) return false;
                out.arr.push_back(std::move(v));
                ws(p);
                if (*p == ',') { p++; continue; }
                if (*p == ']') { p++; return true; }
                return false;
            }
        }
        if (*p == '"') {
            p++; out.kind = STR;
            while (*p && *p != '"') {
                if (*p == '\\' && p[1]) {
                    p++;
                    char c = *p;
                    if (c == 'n') out.str += '\n'; else if (c == 't') out.str += '\t';
                    else if (c == 'u') { unsigned cp = (unsigned)std::strtoul(std::string(p + 1, 4).c_str(), nullptr, 16); p += 4;
                        if (cp < 0x80) out.str += (char)cp;
                        else if (cp < 0x800) { out.str += (char)(0xC0 | (cp >> 6)); out.str += (char)(0x80 | (cp & 63)); }
                        else { out.str += (char)(0xE0 | (cp >> 12)); out.str += (char)(0x80 | ((cp >> 6) & 63)); out.str += (char)(0x80 | (cp & 63)); } }
                    else out.str += c;
                    p++;
                } else out.str += *p++;
            }
            if (*p == '"') p++;
            return true;
        }
        if (!std::strncmp(p, "true", 4)) { p += 4; out.kind = BOOL; out.b = true; return true; }
        if (!std::strncmp(p, "false", 5)) { p += 5; out.kind = BOOL; out.b = false; return true; }
        if (!std::strncmp(p, "null", 4)) { p += 4; out.kind = NUL; return true; }
        char *end = nullptr;
        out.num = std::strtod(p, &end);
        if (end == p) return false;
        out.kind = NUM; p = end;
        return true;
    }
};
