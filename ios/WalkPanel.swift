// The walk panel under the map (the mock Kerem approved on 2026-09-25): the place and the GPS fix,
// then what is heard - nearest first, a level bar, the distance - or why nothing is. Five states:
// hearing, loading, nothing in range, weak GPS (holding), location off. Tokens only (Theme.swift);
// the one accent is the level bars; rows are at least 44 pt (M-4). The Sound test and the CPU
// line sit under Developer, opened by a long-press on the place name.
import SwiftUI

struct WalkPanel: View {
    @ObservedObject var walk: Walk
    @ObservedObject var core: Core
    var onLongPress: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: T.s3) {
            header
            if let why = core.paused {
                note(Text("Paused. ").foregroundColor(T.ink) + Text(why))
                Button { core.resume() } label: {
                    Text("Resume").font(T.body(T.sm, .medium)).foregroundStyle(T.ink)
                        .frame(maxWidth: .infinity, minHeight: T.target)
                        .background(T.raised, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.hairline))
                }
            }
            switch walk.mode {
            case .denied: denied
            case .waiting: note(Text("Finding where you are… Or tap the map to listen from there."))
            case .live, .holding, .byHand: hearing
            }
            if let f = walk.failure { note(Text(f)) }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: T.s3) {
            Text(walk.mode == .denied ? "Location is off" : (walk.place ?? "Fieldscape"))
                .font(T.display(T.md)).foregroundStyle(T.ink).lineLimit(1)
                .onLongPressGesture(perform: onLongPress)
            Spacer(minLength: T.s2)
            Button { core.setSound(!core.soundOn) } label: {
                Text(core.soundOn ? "Stop" : "Sound").font(T.body(T.sm, .medium)).foregroundStyle(T.ink)
                    .frame(minWidth: 64, minHeight: T.target)
                    .background(T.raised, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.hairline))
            }
            .accessibilityLabel(core.soundOn ? "Stop the sound" : "Play the sound")
            switch walk.mode {
            case .live(let a): chip(String(format: "±%.0f m", a))
            case .holding(let a): chip(String(format: "±%.0f m · HOLDING", a))
            case .byHand: chip("BY HAND")
            default: EmptyView()
            }
        }
    }

    @ViewBuilder private var hearing: some View {
        /* the route's own sound and the rhythm points in reach (the piece) */
        if walk.route != nil || !walk.rhythms.isEmpty {
            note((walk.route.map { Text("Route ") + Text($0).foregroundColor(T.ink) } ?? Text(""))
                 + (walk.rhythms.isEmpty ? Text("") : Text(walk.route == nil ? "Rhythm " : " · rhythm ") + Text(walk.rhythms.joined(separator: ", ")).foregroundColor(T.ink)))
        }
        /* away from every route: go to one (the map flies there, the walker stands at its start) */
        if walk.route == nil && !walk.routes.isEmpty {
            HStack(spacing: T.s2) {
                ForEach(Array(walk.routes.enumerated()), id: \.offset) { i, r in
                    Button { walk.visit(route: i) } label: {
                        Text(r.name).font(T.body(T.sm, .medium)).foregroundStyle(T.ink).lineLimit(1)
                            .frame(maxWidth: .infinity, minHeight: T.target).padding(.horizontal, T.s2)
                            .background(T.raised, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.hairline))
                    }
                    .accessibilityLabel("Go to " + r.name)
                }
            }
        }
        if walk.rows.isEmpty {
            if let n = walk.nearest {
                note(Text("Nothing in range here. ").foregroundColor(T.ink)
                     + Text("The nearest recording is ") + Text(n.name).foregroundColor(T.ink)
                     + Text(", ") + Text(n.dist < 1000 ? String(format: "%.0f m", n.dist) : String(format: "%.1f km", n.dist / 1000)).font(T.mono()) + Text(" \(n.direction)."))
            } else {
                note(Text("No recordings are published yet."))
            }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(walk.rows.enumerated()), id: \.element.id) { i, r in
                    if i > 0 { Rectangle().fill(T.hairline).frame(height: 1) }
                    row(r)
                }
            }
            if walk.rows.contains(where: { if case .downloading = $0.phase { return true }; return false }) {
                note(Text("First time here: each recording downloads once, then plays offline."))
            }
        }
        if walk.mode == .byHand {
            note(Text("Listening from where you tapped. Drag on the map to walk."))
            Button { walk.useLocation() } label: {
                Text("Use my location").font(T.body(T.sm, .medium)).foregroundStyle(T.ink)
                    .frame(maxWidth: .infinity, minHeight: T.target)
                    .background(T.raised, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.hairline))
            }
        }
        if case .holding = walk.mode {
            note(Text("GPS is too rough here, so the sound holds where you last were until the fix is better than ")
                 + Text("40 m").font(T.mono()) + Text("."))
        }
    }

    private func row(_ r: Walk.Row) -> some View {
        VStack(spacing: T.s1) {
            HStack(spacing: T.s2) {
                Circle().fill(T.lamp).frame(width: 9, height: 9)
                Text(r.name).font(T.body()).foregroundStyle(T.ink).lineLimit(1)
                Spacer(minLength: T.s2)
                Text(detail(r)).font(T.mono()).foregroundStyle(T.dim)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(T.raised)
                    Capsule().fill(r.phase == .playing ? T.accent : T.faint.opacity(0.6))
                        .frame(width: g.size.width * CGFloat(fill(r)))
                        .animation(.easeOut(duration: 0.18), value: fill(r))
                }
            }.frame(height: 5)
        }
        .frame(minHeight: T.target)
        .padding(.vertical, T.s2)
        .accessibilityElement(children: .combine)
    }

    private func detail(_ r: Walk.Row) -> String {
        switch r.phase {
        case .playing: return String(format: "%.0f m", r.dist)
        case .decoding: return "Preparing"
        case .downloading(_, let b): return b > 0 ? String(format: "Downloading · %.1f MB", Double(b) / 1_048_576) : "Downloading"
        }
    }
    private func fill(_ r: Walk.Row) -> Double {
        switch r.phase {
        case .playing: return max(0, min(1, r.level))
        case .downloading(let f, _): return f
        case .decoding: return 1
        }
    }

    private var denied: some View {
        VStack(alignment: .leading, spacing: T.s3) {
            note(Text("Fieldscape plays the recordings placed around you, so it needs to know where you are while the app is open."))
            Button { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } } label: {
                Text("Open Settings").font(T.body(T.sm, .medium)).foregroundStyle(T.ink)
                    .frame(maxWidth: .infinity, minHeight: T.target)
                    .background(T.raised, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.hairline))
            }
            note(Text("Settings → Fieldscape → Location → ") + Text("While Using the App").foregroundColor(T.ink))
        }
    }

    /* Units keep their case: an uppercased "m" reads as mega. */
    private func chip(_ s: String) -> some View {
        Text(s).font(T.mono(T.xs)).tracking(T.xs * T.trackMeta).foregroundStyle(T.faint)
            .padding(.horizontal, 6).padding(.vertical, 5)
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(T.hairline))
    }

    private func note(_ t: Text) -> some View {
        t.font(T.body(T.sm)).foregroundStyle(T.dim).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
    }
}

/* The engineering view: the Sound test (bundled recording on slot 0) and the CPU line. */
struct DeveloperPanel: View {
    @ObservedObject var core: Core
    @State var open: Bool
    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: T.s4) {
                Text(core.line).font(T.mono(T.xs)).foregroundStyle(T.faint)
                Toggle("Sound test (bundled recording)", isOn: $core.test).font(T.body(T.sm))
                ForEach(core.params) { p in
                    let v = core.values[p.id] ?? p.min
                    if p.max == 1 && (p.key == "freeze" || p.key == "shape") {
                        Toggle(p.key == "shape" ? "Hann window" : p.name, isOn: Binding(get: { v > 0.5 }, set: { core.set(p.id, $0 ? 1 : 0) }))
                            .font(T.body(T.sm))
                    } else {
                        VStack(alignment: .leading, spacing: T.s1) {
                            Text(p.key == "stretch" ? String(format: "%@  %.1f×", p.name, pow(1024, v)) : String(format: "%@  %.2f %@", p.name, v, p.unit))
                                .font(T.mono(T.xs)).foregroundStyle(T.dim)
                            Slider(value: Binding(get: { v }, set: { core.set(p.id, $0) }), in: p.min...p.max).tint(T.accent)
                        }
                    }
                }
            }.padding(.top, T.s3)
        } label: {
            Text("DEVELOPER").font(T.mono(T.xs)).tracking(T.xs * T.trackEyebrow).foregroundStyle(T.faint)
        }.tint(T.faint)
    }
}
