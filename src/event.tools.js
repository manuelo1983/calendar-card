import moment from './locales';
import CalendarEvent from './calendar-event';


/**
  * group events by the day it's on
  * @param  {Array<CalendarEvent>} events
  * @param  {Object} config
  * @return {Array<Object>}
  */
export function groupEventsByDay(events, config) {

    let groupedEvents = events.reduce((groupedEvents, event) => {
        const day = moment(event.startDateTime).format('YYYY-MM-DD');
        const matchingDateIndex = groupedEvents.findIndex(group => group.day === day);

        if (matchingDateIndex > -1) {
            groupedEvents[matchingDateIndex].events.push(event);
        } else {
            groupedEvents.push({ day, events: [event] });
        }

        return groupedEvents;
    }, []);

    // if we want to show all events for a day even if they go over the events
    // limit then  we have to keep track of the number of events by day and
    // stop at the END of the current day that goes over the limit
    let numberOfEvents = 0;
    let hasMaxedOutEvents = false;
    groupedEvents = groupedEvents.map(group => {
        // if we maxed out then dont worry about any other days after that
        if (hasMaxedOutEvents) return;

        // accumulate  how many events are in each day
        numberOfEvents += group.events.length;

        // did we max the number of events we want to show during this day?
        hasMaxedOutEvents = config.eventsLimit < numberOfEvents;
        return group;
    }).filter(Boolean); // filter out empty days that we may have maxed out on
    
    return groupedEvents;
}

/**
  * opens a calendar event in a new tab if has link
  * @param {CalendarEvent} event
  */
export function getLinkHtml(event) {
    if (event.htmlLink) {
        window.open(event.htmlLink);
    }
}



/**
 * gets all events for all calendars added to this card's config
 * @return {Promise<Object{events, failedEvents}>}
 */
export async function getAllEvents(config, hass){

    // create url params
    const dateFormat = 'YYYY-MM-DDTHH:mm:ss';
    const today = moment().startOf('day');
    const start = today.format(dateFormat);
    const end = today.add(config.numberOfDays, 'days').format(dateFormat);

    // for each calendar entity get all events
    // each entity may be a string of entity id or
    // an object with custom name given with entity id
    const allEvents = [];
    const failedEvents = [];

    const calendarEntityPromises = [];
    config.entities.forEach(entity => {
        const calendarEntity = (entity && entity.entity) || entity;
        const url = `calendars/${calendarEntity}?start=${start}Z&end=${end}Z`;

        // make all requests at once
        calendarEntityPromises.push(
            hass.callApi('get', url)
                .then(rawEvents => {
                    return rawEvents.map(event => {
                        event.entity = entity;
                        return event;
                    });
                })
                .then(events => {
                    allEvents.push(...events);
                })
                .catch(error => {
                    failedEvents.push({
                        name: entity.name || calendarEntity,
                        error
                    });
                })
        );
    });

    // wait until all requests either succeed or fail
    await Promise.all(calendarEntityPromises);
    return { failedEvents, events: processEvents(allEvents, config) };
}

/**
 * converts all calendar events to CalendarEvent objects
 * @param {Array<Events>} listo of raw caldav calendar events
 * @return {Promise<Array<CalendarEvent>>}
 */
export function processEvents(allEvents, config) {
    // for some reason Lit Element is trying to sync multiple times before this is complete causing
    // duplicate events - this forces unique events only by looking at calendar event id
    const uniqueEvents = allEvents.filter((event, index, self) => {
        // an event might have a uid or id (caldav has uid, google has id) via calendar-card/issues/37
        return index === self.findIndex(e => (e.id || e.uid) === (event.uid || event.id));
    });

    const today = moment().startOf('day');
    const now = moment();

    // convert each calendar object to a UI event
    let newEvents = uniqueEvents.reduce((events, caldavEvent) => {
        caldavEvent.originCalendar = config.entities.find(entity => entity.entity === caldavEvent.entity.entity);
        const newEvent = new CalendarEvent(caldavEvent);

        // if config to hide passsed events then check that now
        if (config.hidePastEvents && newEvent.endDateTime.isBefore(now)) {
            return events;
        }

        // if startFromToday config then skip events that are before today's date
        if (config.startFromToday && today.isAfter(newEvent.endDateTime)) {
            return events;
        }

        // if config to hide passsed events then check that now
        if (config.hidePastEvents && newEvent.endDateTime.isBefore(now)) {
            return events;
        }

        // if given ignoreEventsExpression value ignore events that match this title
        if (config.ignoreEventsExpression && newEvent.title) {
            const regex = new RegExp(config.ignoreEventsExpression, 'i');
            if (regex.test(newEvent.title)) return events;
        }

        // if given ignoreEventsByLocationExpression value ignore events that match this location
        if (config.ignoreEventsByLocationExpression && newEvent.location) {
            const regex = new RegExp(config.ignoreEventsByLocationExpression, 'i');
            if (regex.test(newEvent.location)) return events;
        }

        /**
         * if we want to split multi day events and its a multi day event then 
         * get how long then event is and for each day
         * copy the event, add # of days to start/end time for each event 
         * then add as 'new' event
         */
        if (config.showMultiDay && newEvent.isMultiDay) {
            const today = moment().startOf('day');
            const endDate = today.add(config.numberOfDays, 'days');

            let daysLong = (newEvent.endDateTime.diff(newEvent.startDateTime, 'days') + 1);
            const partialEvents = [];

            // if we are all day events then we don't need that last day ending at 12am
            if (newEvent.endDateTime.hour() === 0 && newEvent.endDateTime.minutes() === 0) daysLong -= 1;

            for (let i = 0; i < daysLong; i++) {
                // copy event then add the current day/total days to 'new' event
                const copiedEvent = JSON.parse(JSON.stringify(newEvent.rawEvent));
                copiedEvent.addDays = i;
                copiedEvent.daysLong = daysLong;

                const partialEvent = new CalendarEvent(copiedEvent);

                // only add event if starting before the config numberOfDays
                if (endDate.isAfter(partialEvent.startDateTime)) {
                    partialEvents.push(partialEvent)
                }
            }

            events = events.concat(partialEvents);

        } else {
            events.push(newEvent);
        }

        return events;
    }, []);

    // sort events by date starting with soonest
    newEvents.sort((a, b) => a.startDateTime.isBefore(b.startDateTime) ? -1 : 1);
    return newEvents;
}
