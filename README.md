# Note-Based Spaced Repetition Plugin

## Settings

- Schedule on Weekends
    - If set to false, weekends will be avoided in scheduling future note reviews. A weekday during the following week will be randomly selected for the note.
    - When specifying a note interval as occurring on a weekend day, the note specification will be honored over the setting.

## Note Scheduling

### Note Types

By default, spaced-review notes will use an Anki-like spacing algorithm.

You can select alternative types with the "sr-type" attribute in front-matter:

- periodic: for periodic review
    - You can specify a custom interval for periodic note with the "sr-interval: x" frontmatter attribute, where x is your interval.
    - "sr-ease: 0" also indicates a periodic note
- geometric: for an "anti-srs" note review with long spacings following a geometric sequence.
    - You can specify a custom geometric ease for initial scheduling even with the "sr-ease: -x" frontmatter attribute, where x is your geometric ratio (must be negative for geometric scheduling)

Example front-matter values for scheduling a periodic note with a 15 day interval:
```
sr-type: periodic
sr-interval: 15
```

### Scheduling Reviews on Specific Days

If you want to schedule a note to resurface on a specific day of the week, then you can add a fractional part to the interval, with, rounded to the nearest .1 value, interpreted as follows:

- .0 == Sunday
- .1 == Sunday
- .2 == Monday
- .3 == Tuesday
- .4 == Wednesday
- .5 == Thursday
- .6 == Friday
- .7 == Saturday
- .8 == Saturday
- .9 == Sunday


So example, repeat roughly every 30 days, scheduling for the next Tuesday, you would set:

```
sr-interval: 30.2
```

This works with any type of note.

Note that if you have the "Schedule During Weekend" setting disabled, but specify a note as occurring on a weekend day, the note specification will be honored over the setting.

## Building

## Requirements

- pnpm
- esbuild

```
brew install pnpm esbuild
```

to set up:
```
pnpm install
```

to build:

```
pnpm dev
```

(Note to self: recently I've had to use `npm run dev`)

If you want to run repo inside your vault, need to link after building:

```
    ln -s build/main.js main.js
```
