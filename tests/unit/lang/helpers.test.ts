test("Test translation without interpolation in English", () => {
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { t } = require("src/lang/helpers");
        expect(t("DECKS")).toEqual("Decks");
    });
});

test("Test translation with interpolation in English", () => {
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { t } = require("src/lang/helpers");
        expect(t("STATUS_BAR", { dueNotesCount: 1 })).toEqual("Review: 1 note(s) due");
    });
});
