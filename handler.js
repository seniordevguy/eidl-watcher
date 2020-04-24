'use strict';

const AWS = require('aws-sdk');
const axios = require('axios').default;

// twilio client
const twilioClient = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID, 
  process.env.TWILIO_AUTH_TOKEN
);

// lambda client
const lambda = new AWS.Lambda({
  region: "us-east-1"
});

// dynamodb client
const dynamoDb = new AWS.DynamoDB.DocumentClient();

module.exports.check_site = async _ => {
  const params = {
    TableName: process.env.STATE_TABLE,
    ProjectionExpression: "id,app_state"
  };

  try {
    // get app state from db, if its true that means the cron shouldnt run anymore
    const data = await dynamoDb.scan(params).promise();
    if (data.Items[0].app_state) {
      return { message: "Site is live, and cron job doesnt need to run anymore."};
    }

    // call eidl site to see if redirect response url changed yet
    const response = await axios.get('https://covid19relief.sba.gov');
    // if (response.request.res.responseUrl == "https://www.sba.gov/disaster-assistance/coronavirus-covid-19") {
    //   return { message: "Application site is not live yet." };
    // }

    // if it has, launch lambda to process sms
    const lambData = await lambda.invoke({ 
      FunctionName: `${process.env.APP_NAME}-${process.env.APP_ENV}-process_sms`
    }).promise();

    // update app state
    const updateParams = {
      TableName: process.env.STATE_TABLE,
      Key: {
        id: eidl
      },
      UpdateExpression: "set app_state = :app_state",
      ExpressionAttributeValues: {
          ":app_state": true
      },
      ReturnValues: "UPDATED_NEW"
    };

    await dynamoDb.update(updateParams).promise();

    return { lambData };
  } catch (err) {
    console.error("ERROR\n " + JSON.stringify(err));
    return { error: JSON.stringify(err) };
  }
};

module.exports.process_sms = async _ => {
  const params = {
    TableName: process.env.USER_TABLE,
    FilterExpression: 'sent = :sent',
    ExpressionAttributeValues : {
        ':sent': false
    }   
  };

  try {
    // get all phone numbers in the db that arent marked as sent
    const data = await dynamoDb.scan(params).promise();
    const chunk = 50;
    const count = 0;
    const lambResps = [];

    // chunk phone numbers into chunks of 50 and launch lambdas
    for (let i = 0; i < data.Items.length; i += chunk) {
        const chunkedNumbers = data.Items.slice(i, i + chunk);
        
        // launch lambda for each chunk of phone numbers
        const lambData = await lambda.invoke({ 
          FunctionName: `${process.env.APP_NAME}-${process.env.APP_ENV}-send_sms`,
          Payload: JSON.stringify(chunkedNumbers)
        }).promise();

        // push resp to array
        lambResps.push(lambData);
        count++;
    }

    // send response back
    return { message: `Launched ${count} SMS Lamdas!`, lambResps };
  } catch (err) {
    console.error("ERROR\n " + JSON.stringify(err));
    return { error: JSON.stringify(err) };
  }
};

module.exports.send_sms = async event => {
  try {
    // parse phone number array from event payload
    const phoneNumbers = JSON.parse(event);
    const entryResps = [];

    // loop through each phone number and send sms from twilio
    for (let i = 0; i < phoneNumbers.length; i++) {
      const resp = await twilioClient.messages.create({
        body: 'COVID SITE IS ONLINE! - https://covid19relief.sba.gov',
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        to: phoneNumbers[i].phone_number
      });

      // push sid to array
      const entryResp = { sId: resp.sid };

      // mark sent: true, in dynamodb
      const params = {
        TableName: process.env.USER_TABLE,
        Key: {
          phone_number: phoneNumbers[i].phone_number
        },
        UpdateExpression: "set sent = :sent",
            ExpressionAttributeValues:{
                ":sent": true
            },
            ReturnValues: "UPDATED_NEW"
      };

      await dynamoDb.update(params).promise();

      // add entry to the array resp
      entryResp.phoneNumber = phoneNumbers[i].phoneNumber
      entryResps.push(entryResp);
    }

    // send response back
    return { message: "Processed all SMS successfully!", entryResps };
  } catch (err) {
    console.error("ERROR\n " + JSON.stringify(err));
    return { error: JSON.stringify(err) };
  }
};