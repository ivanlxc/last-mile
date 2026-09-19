// Original score audition renderer. macOS / Swift / AVFoundation, offline only.
// Never opens the microphone or plays through the system output device.
// Usage: swift scripts/render-music-audition.swift score.json output.wav
import Foundation
import AVFoundation
import AudioToolbox

struct Note: Decodable {
    let beat: Double
    let duration: Double
    let midi: Int
    let velocity: Int
}
struct GainPoint: Decodable {
    let beat: Double
    let gain: Float
}
struct Track: Decodable {
    let name: String
    let instrument: String
    let volume: Float
    let pan: Float
    let notes: [Note]
    // Optional expression multiplier. Older scores retain their fixed mix.
    let gainAutomation: [GainPoint]?
}
struct Score: Decodable {
    let title: String
    let bpm: Double
    let bars: Int
    let beatsPerBar: Int
    let tailSeconds: Double
    let tracks: [Track]
    let renderReverbPercent: Float?
    let renderLowPassHz: Float?
}
struct Event {
    let sample: Int64
    let track: Int
    let midi: UInt8
    let velocity: UInt8
    let on: Bool
}
enum RenderError: Error {
    case invalid(String)
}

func expression(at beat: Double, points: [GainPoint]) -> Float {
    guard let first = points.first, let last = points.last else { return 1 }
    if beat <= first.beat { return first.gain }
    if beat >= last.beat { return last.gain }
    for index in 1..<points.count where beat < points[index].beat {
        let previous = points[index - 1]
        let next = points[index]
        let fraction = Float((beat - previous.beat) / (next.beat - previous.beat))
        return previous.gain + (next.gain - previous.gain) * fraction
    }
    return last.gain
}

func render() throws {
    guard CommandLine.arguments.count == 3 else {
        throw RenderError.invalid("Usage: swift render-music-audition.swift score.json output.wav")
    }
    let scoreURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let score = try JSONDecoder().decode(Score.self, from: Data(contentsOf: scoreURL))
    guard score.bpm > 0, score.bars > 0, score.beatsPerBar > 0,
          score.tailSeconds >= 2, !score.tracks.isEmpty else {
        throw RenderError.invalid("Invalid score dimensions")
    }
    let programs: [String: UInt8] = [
        "piano": 0, "cello": 42, "strings": 48, "warm_pad": 89,
        "harp": 46, "bass": 43,
        "pizzicato": 45, "marimba": 12, "clarinet": 71,
        "tremolo_strings": 44,
    ]
    // The local macOS sound bank is used in place and never copied into the repo.
    let bank = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
    let engine = AVAudioEngine()
    let rate = 48000.0
    let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
    let sum = AVAudioMixerNode()
    let tone = AVAudioUnitEQ(numberOfBands: 3)
    tone.bands[0].filterType = .highPass
    tone.bands[0].frequency = 42
    tone.bands[0].bypass = false
    tone.bands[1].filterType = .highShelf
    tone.bands[1].frequency = 4000
    tone.bands[1].gain = -3
    tone.bands[1].bypass = false
    tone.bands[2].bypass = true
    if let cutoff = score.renderLowPassHz {
        guard (200...20000).contains(cutoff) else {
            throw RenderError.invalid("Low-pass cutoff is outside the audible design range")
        }
        tone.bands[2].filterType = .lowPass
        tone.bands[2].frequency = cutoff
        tone.bands[2].bypass = false
    }
    let space = AVAudioUnitReverb()
    let reverb = score.renderReverbPercent ?? 24
    guard (0...100).contains(reverb) else {
        throw RenderError.invalid("Reverb percentage must be between 0 and 100")
    }
    space.loadFactoryPreset(reverb < 20 ? .mediumRoom : .largeHall2)
    space.wetDryMix = reverb
    engine.attach(sum)
    engine.attach(tone)
    engine.attach(space)
    engine.connect(sum, to: tone, format: format)
    engine.connect(tone, to: space, format: format)
    engine.connect(space, to: engine.mainMixerNode, format: format)
    engine.mainMixerNode.outputVolume = 0.75
    var instruments: [AVAudioUnitSampler] = []
    var trackMixers: [AVAudioMixerNode] = []
    var events: [Event] = []
    let beatSeconds = 60.0 / score.bpm
    let totalBeats = Double(score.bars * score.beatsPerBar)
    let hasAutomation = score.tracks.contains { !($0.gainAutomation ?? []).isEmpty }
    for (index, track) in score.tracks.enumerated() {
        guard let program = programs[track.instrument],
              (0...1).contains(track.volume), (-1...1).contains(track.pan) else {
            throw RenderError.invalid("Invalid track: \(track.name)")
        }
        var previousBeat = -Double.infinity
        for point in track.gainAutomation ?? [] {
            guard point.beat.isFinite, point.beat >= 0, point.beat <= totalBeats,
                  point.beat > previousBeat, (0...2).contains(point.gain),
                  track.volume * point.gain <= 1 else {
                throw RenderError.invalid("Invalid gain automation in \(track.name)")
            }
            previousBeat = point.beat
        }
        let sampler = AVAudioUnitSampler()
        let mixer = AVAudioMixerNode()
        engine.attach(sampler)
        engine.attach(mixer)
        try sampler.loadSoundBankInstrument(at: bank, program: program,
            bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB),
            bankLSB: UInt8(kAUSampler_DefaultBankLSB))
        engine.connect(sampler, to: mixer, format: format)
        engine.connect(mixer, to: sum, fromBus: 0, toBus: AVAudioNodeBus(index), format: format)
        mixer.outputVolume = track.volume * expression(at: 0, points: track.gainAutomation ?? [])
        mixer.pan = track.pan
        // Consistent external space, no instrument-specific General MIDI chorus.
        sampler.sendController(91, withValue: 0, onChannel: 0)
        sampler.sendController(93, withValue: 0, onChannel: 0)
        instruments.append(sampler)
        trackMixers.append(mixer)
        for note in track.notes {
            guard note.beat >= 0, note.beat < totalBeats, note.duration > 0,
                  note.beat + note.duration <= totalBeats + 0.05,
                  (0...127).contains(note.midi), (1...127).contains(note.velocity) else {
                throw RenderError.invalid("Invalid note in \(track.name): \(note)")
            }
            let onset = Int64((note.beat * beatSeconds * rate).rounded())
            let offset = Int64(((note.beat + note.duration) * beatSeconds * rate).rounded())
            events.append(Event(sample: onset, track: index, midi: UInt8(note.midi), velocity: UInt8(note.velocity), on: true))
            events.append(Event(sample: offset, track: index, midi: UInt8(note.midi), velocity: 0, on: false))
        }
    }
    events.sort {
        if $0.sample != $1.sample { return $0.sample < $1.sample }
        if $0.on != $1.on { return !$0.on }
        return $0.track < $1.track
    }
    try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
    engine.prepare()
    try engine.start()
    defer { engine.stop() }
    var fileSettings = format.settings
    fileSettings[AVLinearPCMIsNonInterleaved] = false
    let file = try AVAudioFile(forWriting: outputURL, settings: fileSettings)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096)!
    let totalSamples = Int64(((totalBeats * beatSeconds + score.tailSeconds) * rate).rounded())
    var cursor: Int64 = 0
    var eventIndex = 0
    var retries = 0
    while cursor < totalSamples {
        while eventIndex < events.count && events[eventIndex].sample <= cursor {
            let event = events[eventIndex]
            let sampler = instruments[event.track]
            if event.on {
                sampler.startNote(event.midi, withVelocity: event.velocity, onChannel: 0)
            } else {
                sampler.stopNote(event.midi, onChannel: 0)
            }
            eventIndex += 1
        }
        let boundary = eventIndex < events.count ? events[eventIndex].sample : totalSamples
        // At 48 kHz, 256-frame expression updates are ~5 ms apart. This shapes
        // sustained phrases before the shared reverb, whose tails decay naturally.
        let count = AVAudioFrameCount(min(hasAutomation ? 256 : 4096, boundary - cursor, totalSamples - cursor))
        if hasAutomation {
            let beat = (Double(cursor) + Double(count) / 2) / rate / beatSeconds
            for (index, track) in score.tracks.enumerated() {
                trackMixers[index].outputVolume = track.volume * expression(
                    at: beat, points: track.gainAutomation ?? [])
            }
        }
        let result = try engine.renderOffline(count, to: buffer)
        switch result {
        case .success:
            guard buffer.frameLength > 0 else { throw RenderError.invalid("Empty rendered buffer") }
            try file.write(from: buffer)
            cursor += Int64(buffer.frameLength)
            retries = 0
        case .cannotDoInCurrentContext:
            retries += 1
            if retries > 100 { throw RenderError.invalid("Offline rendering stalled") }
        default:
            throw RenderError.invalid("Offline rendering status: \(result.rawValue)")
        }
    }
    print("Rendered \(score.title): \(score.tracks.count) tracks, \(events.count / 2) notes, \(Double(totalSamples) / rate)s -> \(outputURL.path)")
}

do {
    try render()
} catch {
    fputs("Music audition error: \(error)\n", stderr)
    exit(1)
}
