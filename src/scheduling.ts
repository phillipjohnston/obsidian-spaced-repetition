import { TFile } from "obsidian";

import { SRSettings } from "src/settings";
import { t } from "src/lang/helpers";

export enum ReviewResponse {
    Easy,
    Good,
    Hard,
    Reset,
    Postpone,
    PostponeLong
}

function hasFractionalPart(num) {
    return num !== Math.floor(num);
}

function getFractionalPart(num) {
    return num - Math.floor(num);
}

/* Convert from the note interval mapping to Date/window.moment
 * expectations
 * - .0 == Sunday
 * - .1 == Sunday
 * - .2 == Monday
 * - .3 == Tuesday
 * - .4 == Wednesday
 * - .5 == Thursday
 * - .6 == Friday
 * - .7 == Saturday
 * - .8 == Sunday
 * - .9 == Sunday
*/
function normalizeDay(input_day)
{
    if(input_day == 0)
    {
        return 0;
    }
    else if(input_day >= 1 && input_day <= 7)
    {
        return input_day - 1;
    }
    else
    {
        return 0;
    }
}

export function calculateDueDate(interval)
{
    const now = window.moment(Date.now());

    if(hasFractionalPart(interval))
    {
        var target_day = normalizeDay(Math.round(getFractionalPart(interval)*10));
        interval = Math.floor(interval);
        var dueDate = now.add(interval, 'days');
        var adjustment_days = (target_day - dueDate.day() + 7) % 7;
        return dueDate.add(adjustment_days, 'days');
    }
    else
    {
        return now.add(interval, 'days')
    }
}

export function schedule(
    response: ReviewResponse,
    interval: number,
    ease: number,
    delayBeforeReview: number,
    settingsObj: SRSettings,
    dueDates?: Record<number, number>,
): Record<string, number> {
    delayBeforeReview = Math.max(0, Math.floor(delayBeforeReview / (24 * 3600 * 1000)));

    // This represents normal SRS behavior
    if(ease > 0)
    {
        if (response === ReviewResponse.Easy) {
            ease += 20;
            interval = ((interval + delayBeforeReview) * ease) / 100;
            interval *= settingsObj.easyBonus;
        } else if (response === ReviewResponse.Good) {
            interval = ((interval + delayBeforeReview / 2) * ease) / 100;
        } else if (response === ReviewResponse.Hard) {
            ease = Math.max(130, ease - 20);
            interval = Math.max(
                1,
                (interval + delayBeforeReview / 4) * settingsObj.lapsesIntervalChange,
            );
        }

        // replaces random fuzz with load balancing over the fuzz interval
        if (dueDates !== undefined) {
            interval = Math.round(interval);
            if (!Object.prototype.hasOwnProperty.call(dueDates, interval)) {
                dueDates[interval] = 0;
            } else {
                // This code fuzzes for all intervals, not just > 4
                let fuzz = 0;
                if (interval < 7) fuzz = 1;
                else if (interval < 30) fuzz = Math.max(2, Math.floor(interval * 0.15));
                else fuzz = Math.max(4, Math.floor(interval * 0.05));

                const originalInterval = interval;
                outer: for (let i = 1; i <= fuzz; i++) {
                    for (const ivl of [originalInterval - i, originalInterval + i]) {
                        if (!Object.prototype.hasOwnProperty.call(dueDates, ivl)) {
                            dueDates[ivl] = 0;
                            interval = ivl;
                            break outer;
                        }
                        if (dueDates[ivl] < dueDates[interval]) interval = ivl;
                    }
                }
            }

            dueDates[interval]++;
        }

        interval = Math.round(interval * 10) / 10
    }
    else if(ease == 0)
    {
        // When ease is zero, we just review a note on a periodic basis.

        // Easy and hard adjust the periodic interval, but we have to be careful
        // to not adjust the fractional portion for days-of-the-week
        if (response === ReviewResponse.Easy) {
            var fractional = getFractionalPart(interval);
            interval = Math.round(Math.floor(interval) * 1.2) + fractional;
        } else if (response === ReviewResponse.Hard) {
            var fractional = getFractionalPart(interval);
            interval = Math.round(Math.floor(interval) * 0.5) + fractional;
        }
    }
    else
    {
        // The goal here is a geometric series that allows for greatly increasing expansion of intervals
        // so that we reduce our iteration.
        // Idea comes from gwern: https://gwern.net/note/statistic#program-for-non-spaced-repetition-review-of-past-written-materials-for-serendipity-rediscovery-archive-revisiter
        // He uses a constant of 7.7238823216. This gives an expectation of four reviews over a 30 year period.
        // I wanted more than that, so I went lower, and trying 2.91 as the ratio for now.
        // I don't have a way to create this in code, so
        // He also uses a formula of next_review(iteration, ratio, initial_value) = a * (1-r^n) / (1-r)
        // But I went with a simpler implementation of r * a(n-1) as I don't currently have number
        // of iterations tracked, so his formula wouldn't work.

        // TBD: do we fuzz anti-srs?

        // For now, we're hacking on top of the existing idea of ease/interval.
        // ease will represent "ratio", and is expected to be negative to get into this logic loop,
        // so we must correct for that.
        // "interval" will be "a", the initial value (or previous iteration)

        // Response affects the ease
        // For most case, just review normal
        if (response === ReviewResponse.Easy) {
            ease *= 1.5;
        } else if (response === ReviewResponse.Hard) {
            ease *= 0.5;
        }

        // Special case for the first interval: we'll go to our planned initial review point,
        // which is 30 days out
        if(interval == 1)
        {
            interval = 30;
        }
        else
        {
            // The -1 multiplication is because ease is marked negative to
            // indicate a geometric progression.
            //
            // delayBeforeReview was removed from this calculation.
            // We DON'T want to incorporate delay before review
            // because we just want the interval to progress normally, rather than
            // increasing because there was a small delay in reviewing.
           var fractional = getFractionalPart(interval);
           interval =  Math.floor(Math.floor((interval)) * (-1 * ease)) + fractional;
        }
    }

    interval = Math.min(interval, settingsObj.maximumInterval);

    return { interval, ease };
}

export function textInterval(interval: number, isMobile: boolean): string {
    if (interval === undefined) {
        return t("NEW");
    }

    const m: number = Math.round(interval / 3.04375) / 10,
        y: number = Math.round(interval / 36.525) / 10;

    if (isMobile) {
        if (m < 1.0) return t("DAYS_STR_IVL_MOBILE", { interval });
        else if (y < 1.0) return t("MONTHS_STR_IVL_MOBILE", { interval: m });
        else return t("YEARS_STR_IVL_MOBILE", { interval: y });
    } else {
        if (m < 1.0) return t("DAYS_STR_IVL", { interval });
        else if (y < 1.0) return t("MONTHS_STR_IVL", { interval: m });
        else return t("YEARS_STR_IVL", { interval: y });
    }
}
