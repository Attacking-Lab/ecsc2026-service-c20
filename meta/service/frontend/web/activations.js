// Special activations: a map tile marked `activate: ID` (Select mode in the
// map editor) makes Enter next to it run ACTIVATIONS[ID]. Every tile marked
// with the same ID is one object: it is found, animated and spoken for as a
// whole. Animated tiles keep looping, unless the activation is `oneShot`: then
// they hold their first frame until it plays them once.
//
// run(ctx) gets:
//   ctx.playOnce()        play the object's animation through one cycle;
//                         false if a cycle is already running
//   ctx.say(text, opts)   a speech bubble over the object; opts.dx / opts.dy
//                         shift it by that many room px (+ is right / down),
//                         opts.ms is how long it shows before fading
//   ctx.atFrame(n, fn)    run fn when that animation reaches frame n
//   ctx.after(ms, fn)     run fn ms from now
//   ctx.fadeOut(ms)       fade the object out; gone (no drawing, no collision,
//                         no Enter) until the room is entered again
//   ctx.roll              a number in [0, 1), the same for every player who sees
//                         this activation (use it instead of Math.random)
//
// Activations reach the other players in the room through the presence relay,
// which replays them on their screens; run should only act on the room.

export const ACTIVATIONS = {
  birthday_jackbox: {
    label: "jack-in-the-box",
    hint: "open the jack-in-the-box",
    oneShot: true,
    run(ctx) {
      if (!ctx.playOnce()) return;
      // Frame 8 is where the jack has sprung highest out of the box.
      ctx.atFrame(8, () => ctx.say("Happy Birthday Trixter!", { dx: -1, dy: 8, ms: 1000 }));
    },
  },
  halloween_ghost: {
    label: "ghost",
    hint: "poke the ghost",
    run(ctx) {
      ctx.say("oww, man :c", { ms: 1000 });
      ctx.after(1000, () => ctx.fadeOut(500));
    },
  },
  lounge_cat: {
    label: "cat",
    hint: "pet the cat",
    run(ctx) {
      const words = ["meow", "mrrp", "mau"];
      ctx.say(words[Math.floor(ctx.roll * words.length)], { ms: 1000 });
    },
  },
};
