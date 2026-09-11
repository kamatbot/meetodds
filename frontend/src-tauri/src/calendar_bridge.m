#import <Foundation/Foundation.h>
#import <EventKit/EventKit.h>
#include <stdlib.h>
#include <string.h>

typedef void (*MeetOddsCalendarPermissionCallback)(int granted, const char *error_message, void *context);

static BOOL MeetOddsCalendarHasFullAccess(void) {
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 140000
    if (@available(macOS 14.0, *)) {
        return status == EKAuthorizationStatusFullAccess;
    }
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    return status == EKAuthorizationStatusAuthorized;
#pragma clang diagnostic pop
}

__attribute__((visibility("default")))
int meetodds_calendar_authorization_status(void) {
    return (int)[EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
}

__attribute__((visibility("default")))
void meetodds_calendar_request_access(MeetOddsCalendarPermissionCallback callback, void *context) {
    if (!callback) return;
    @autoreleasepool {
        EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
        if (MeetOddsCalendarHasFullAccess()) {
            callback(1, NULL, context);
            return;
        }
        if (status == EKAuthorizationStatusDenied || status == EKAuthorizationStatusRestricted) {
            callback(0, "Calendar access is disabled in System Settings.", context);
            return;
        }

        EKEventStore *store = [[EKEventStore alloc] init];
        void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
            const char *message = error.localizedDescription.UTF8String;
            callback(granted ? 1 : 0, message, context);
            (void)store; // Keep the store alive until EventKit finishes the request.
        };

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 140000
        if (@available(macOS 14.0, *)) {
            [store requestFullAccessToEventsWithCompletion:completion];
            return;
        }
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        [store requestAccessToEntityType:EKEntityTypeEvent completion:completion];
#pragma clang diagnostic pop
    }
}

static BOOL MeetOddsLooksLikeConferenceHost(NSString *host) {
    if (host.length == 0) return NO;
    NSString *value = host.lowercaseString;
    NSArray<NSString *> *needles = @[
        @"zoom.us", @"meet.google.", @"teams.microsoft.", @"teams.live.",
        @"webex.com", @"whereby.com", @"around.co", @"chime.aws",
        @"ringcentral.com", @"gotomeeting.com", @"slack.com"
    ];
    for (NSString *needle in needles) {
        if ([value containsString:needle]) return YES;
    }
    return NO;
}

static NSString *MeetOddsConferenceURL(EKEvent *event) {
    NSURL *direct = event.URL;
    if (direct && MeetOddsLooksLikeConferenceHost(direct.host)) {
        return direct.absoluteString;
    }

    // Calendar locations are often the join URL itself, including less common providers.
    NSString *location = event.location;
    if ([location hasPrefix:@"https://"] || [location hasPrefix:@"http://"]) {
        NSURL *url = [NSURL URLWithString:location];
        if (url) return url.absoluteString;
    }

    NSArray<NSString *> *candidates = @[
        event.location ?: @"",
        event.notes ?: @""
    ];
    NSError *detectorError = nil;
    NSDataDetector *detector = [NSDataDetector dataDetectorWithTypes:NSTextCheckingTypeLink error:&detectorError];
    if (!detector || detectorError) return nil;
    for (NSString *text in candidates) {
        if (text.length == 0) continue;
        NSArray<NSTextCheckingResult *> *matches = [detector matchesInString:text options:0 range:NSMakeRange(0, text.length)];
        for (NSTextCheckingResult *match in matches) {
            NSURL *url = match.URL;
            if (url && MeetOddsLooksLikeConferenceHost(url.host)) return url.absoluteString;
        }
    }
    return nil;
}

static char *MeetOddsCopyUTF8(NSString *value) {
    if (!value) return NULL;
    const char *utf8 = value.UTF8String;
    return utf8 ? strdup(utf8) : NULL;
}

__attribute__((visibility("default")))
char *meetodds_calendar_events_json(double start_epoch, double end_epoch, char **error_out) {
    if (error_out) *error_out = NULL;
    @autoreleasepool {
        if (!MeetOddsCalendarHasFullAccess()) {
            if (error_out) *error_out = MeetOddsCopyUTF8(@"Calendar permission is not granted.");
            return NULL;
        }
        if (!isfinite(start_epoch) || !isfinite(end_epoch) || end_epoch <= start_epoch) {
            if (error_out) *error_out = MeetOddsCopyUTF8(@"Invalid calendar time range.");
            return NULL;
        }

        EKEventStore *store = [[EKEventStore alloc] init];
        NSDate *start = [NSDate dateWithTimeIntervalSince1970:start_epoch];
        NSDate *end = [NSDate dateWithTimeIntervalSince1970:end_epoch];
        NSPredicate *predicate = [store predicateForEventsWithStartDate:start endDate:end calendars:nil];
        NSArray<EKEvent *> *events = [store eventsMatchingPredicate:predicate];
        NSMutableArray<NSDictionary *> *result = [NSMutableArray arrayWithCapacity:events.count];

        for (EKEvent *event in events) {
            if (event.isAllDay || event.status == EKEventStatusCanceled) continue;
            NSString *identifier = event.calendarItemIdentifier ?: event.eventIdentifier;
            if (identifier.length == 0) continue;
            NSString *title = event.title.length ? event.title : @"Untitled meeting";
            NSMutableDictionary *item = [@{
                @"id": identifier,
                @"title": title,
                @"startAtMs": @([event.startDate timeIntervalSince1970] * 1000.0),
                @"endAtMs": @([event.endDate timeIntervalSince1970] * 1000.0),
                @"allDay": @(event.isAllDay),
                @"attendeeCount": @(event.attendees.count)
            } mutableCopy];
            if (event.location.length) item[@"location"] = event.location;
            if (event.calendar.title.length) item[@"calendarName"] = event.calendar.title;
            NSString *conference = MeetOddsConferenceURL(event);
            if (conference.length) item[@"conferenceUrl"] = conference;
            [result addObject:item];
        }

        [result sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
            return [left[@"startAtMs"] compare:right[@"startAtMs"]];
        }];

        NSError *jsonError = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:&jsonError];
        if (!data || jsonError) {
            if (error_out) *error_out = MeetOddsCopyUTF8(jsonError.localizedDescription ?: @"Calendar events could not be encoded.");
            return NULL;
        }
        NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        return MeetOddsCopyUTF8(json);
    }
}

__attribute__((visibility("default")))
void meetodds_calendar_free_string(char *value) {
    if (value) free(value);
}
