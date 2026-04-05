import {
  EVENTS,
  FORM_ERROR_TYPE,
  INPUT_VALIDATION_RULES,
  ROOT_ERROR_TYPE,
  VALIDATION_MODE,
} from '../constants';
import type {
  BatchFieldArrayUpdate,
  ChangeHandler,
  Control,
  DeepPartial,
  DelayCallback,
  EventType,
  Field,
  FieldError,
  FieldErrors,
  FieldNamesMarkedBoolean,
  FieldPath,
  FieldRefs,
  FieldValues,
  FormState,
  FromSubscribe,
  GetIsDirty,
  GetValuesConfig,
  InternalFieldName,
  Names,
  Path,
  ReadFormState,
  Ref,
  SetFieldValue,
  SetValueConfig,
  Subjects,
  UseFormClearErrors,
  UseFormGetFieldState,
  UseFormGetValues,
  UseFormHandleSubmit,
  UseFormProps,
  UseFormRegister,
  UseFormReset,
  UseFormResetField,
  UseFormSetError,
  UseFormSetFocus,
  UseFormSetValue,
  UseFormSubscribe,
  UseFormTrigger,
  UseFormUnregister,
  UseFormWatch,
  ValidateFormEventType,
  WatchInternal,
  WatchObserver,
} from '../types';
import { get, set } from '../utils';
import cloneObject from '../utils/cloneObject';
import compact from '../utils/compact';
import convertToArrayPayload from '../utils/convertToArrayPayload';
import createSubject from '../utils/createSubject';
import deepEqual from '../utils/deepEqual';
import extractFormValues from '../utils/extractFormValues';
import isBoolean from '../utils/isBoolean';
import isCheckBoxInput from '../utils/isCheckBoxInput';
import isDateObject from '../utils/isDateObject';
import isEmptyObject from '../utils/isEmptyObject';
import isFileInput from '../utils/isFileInput';
import isFunction from '../utils/isFunction';
import isHTMLElement from '../utils/isHTMLElement';
import isMultipleSelect from '../utils/isMultipleSelect';
import isNullOrUndefined from '../utils/isNullOrUndefined';
import isObject from '../utils/isObject';
import isRadioOrCheckbox from '../utils/isRadioOrCheckbox';
import isString from '../utils/isString';
import isUndefined from '../utils/isUndefined';
import isWeb from '../utils/isWeb';
import live from '../utils/live';
import unset from '../utils/unset';

import generateWatchOutput from './generateWatchOutput';
import getDirtyFields from './getDirtyFields';
import getEventValue from './getEventValue';
import getFieldValue from './getFieldValue';
import getFieldValueAs from './getFieldValueAs';
import getNodeParentName from './getNodeParentName';
import getResolverOptions from './getResolverOptions';
import getRuleValue from './getRuleValue';
import getValidationModes from './getValidationModes';
import hasPromiseValidation from './hasPromiseValidation';
import hasValidation from './hasValidation';
import isNameInFieldArray from './isNameInFieldArray';
import isWatched from './isWatched';
import iterateFieldsByAction from './iterateFieldsByAction';
import schemaErrorLookup from './schemaErrorLookup';
import shouldRenderFormState from './shouldRenderFormState';
import shouldSubscribeByName from './shouldSubscribeByName';
import skipValidation from './skipValidation';
import unsetEmptyArray from './unsetEmptyArray';
import updateFieldArrayRootError from './updateFieldArrayRootError';
import validateField from './validateField';

const defaultOptions = {
  mode: VALIDATION_MODE.onSubmit,
  reValidateMode: VALIDATION_MODE.onChange,
  shouldFocusError: true,
} as const;

const defaultProxyFormState: ReadFormState = {
  isDirty: false,
  dirtyFields: false,
  validatingFields: false,
  touchedFields: false,
  isValidating: false,
  isValid: false,
  errors: false,
};

class FormControl<
  TFieldValues extends FieldValues = FieldValues,
  TContext = any,
  TTransformedValues = TFieldValues,
> {
  _options: UseFormProps<TFieldValues, TContext, TTransformedValues>;

  _formState: FormState<TFieldValues>;

  _fields: FieldRefs = {};

  _defaultValues: object; // DefaultValues<TFieldValues>;

  _formValues: TFieldValues;

  _state = {
    action: false,
    mount: false,
    watch: false,
    keepIsValid: false,
  };

  _names: Names = {
    mount: new Set(),
    disabled: new Set(),
    unMount: new Set(),
    array: new Set(),
    watch: new Set(),
    registerName: new Set(),
  };

  _proxyFormState: ReadFormState = {
    ...defaultProxyFormState,
  };

  _proxySubscribeFormState = {
    ...this._proxyFormState,
  };

  _subjects: Subjects<TFieldValues> = {
    array: createSubject(),
    state: createSubject(),
  };

  delayErrorCallback?: DelayCallback;

  timer?: number;

  get shouldDisplayAllAssociatedErrors() {
    return this._options.criteriaMode === VALIDATION_MODE.all;
  }

  constructor(
    public props: UseFormProps<TFieldValues, TContext, TTransformedValues> = {},
  ) {
    this._options = {
      ...defaultOptions,
      ...props,
    };

    this._formState = {
      submitCount: 0,
      isDirty: false,
      isReady: false,
      isLoading: isFunction(this._options.defaultValues),
      isValidating: false,
      isSubmitted: false,
      isSubmitting: false,
      isSubmitSuccessful: false,
      isValid: false,
      touchedFields: {},
      dirtyFields: {},
      validatingFields: {},
      errors: this._options.errors || {},
      disabled: this._options.disabled || false,
    };

    this._defaultValues =
      isObject(this._options.defaultValues) || isObject(this._options.values)
        ? cloneObject(this._options.defaultValues || this._options.values) || {}
        : {};

    this._formValues = (
      this._options.shouldUnregister ? {} : cloneObject(this._defaultValues)
    ) as any;
  }

  debounce =
    <T extends Function>(callback: T) =>
    (wait: number) => {
      clearTimeout(this.timer);
      this.timer = setTimeout(callback, wait);
    };

  _setValid = async (shouldUpdateValid?: boolean) => {
    if (this._state.keepIsValid) {
      return;
    }
    if (
      !this._options.disabled &&
      (this._proxyFormState.isValid ||
        this._proxySubscribeFormState.isValid ||
        shouldUpdateValid)
    ) {
      let isValid: boolean;
      if (this._options.resolver) {
        isValid = isEmptyObject((await this._runSchema()).errors);
        this._updateIsValidating();
      } else {
        isValid = await this.executeBuiltInValidation({
          fields: this._fields,
          onlyCheckValid: true,
          eventType: EVENTS.VALID,
        });
      }
      if (isValid !== this._formState.isValid) {
        this._subjects.state.next({ isValid });
      }
    }
  };

  _updateIsValidating = (names?: string[], isValidating?: boolean) => {
    if (
      !this._options.disabled &&
      (this._proxyFormState.isValidating ||
        this._proxyFormState.validatingFields ||
        this._proxySubscribeFormState.isValidating ||
        this._proxySubscribeFormState.validatingFields)
    ) {
      (names || Array.from(this._names.mount)).forEach((name) => {
        if (name) {
          isValidating
            ? set(this._formState.validatingFields, name, isValidating)
            : unset(this._formState.validatingFields, name);
        }
      });

      this._subjects.state.next({
        validatingFields: this._formState.validatingFields,
        isValidating: !isEmptyObject(this._formState.validatingFields),
      });
    }
  };

  _updateDirtyFields = (name: InternalFieldName) => {
    const fullDirtyFields = getDirtyFields(
      this._defaultValues,
      this._formValues,
    );
    const rootName = getNodeParentName(name);
    set(this._formState.dirtyFields, rootName, get(fullDirtyFields, rootName));
  };

  _setFieldArray: BatchFieldArrayUpdate = (
    name,
    values = [],
    method,
    args,
    shouldSetValues = true,
    shouldUpdateFieldsAndState = true,
  ) => {
    if (args && method && !this._options.disabled) {
      this._state.action = true;
      if (
        shouldUpdateFieldsAndState &&
        Array.isArray(get(this._fields, name))
      ) {
        const fieldValues = method(
          get(this._fields, name),
          args.argA,
          args.argB,
        );
        shouldSetValues && set(this._fields, name, fieldValues);
      }

      if (
        shouldUpdateFieldsAndState &&
        Array.isArray(get(this._formState.errors, name))
      ) {
        const errors = method(
          get(this._formState.errors, name),
          args.argA,
          args.argB,
        );
        shouldSetValues && set(this._formState.errors, name, errors);
        unsetEmptyArray(this._formState.errors, name);
      }

      if (
        (this._proxyFormState.touchedFields ||
          this._proxySubscribeFormState.touchedFields) &&
        shouldUpdateFieldsAndState &&
        Array.isArray(get(this._formState.touchedFields, name))
      ) {
        const touchedFields = method(
          get(this._formState.touchedFields, name),
          args.argA,
          args.argB,
        );
        shouldSetValues &&
          set(this._formState.touchedFields, name, touchedFields);
      }

      if (
        this._proxyFormState.dirtyFields ||
        this._proxySubscribeFormState.dirtyFields
      ) {
        this._updateDirtyFields(name);
      }

      this._subjects.state.next({
        name,
        isDirty: this._getDirty(name, values),
        dirtyFields: this._formState.dirtyFields,
        errors: this._formState.errors,
        isValid: this._formState.isValid,
      });
    } else {
      set(this._formValues, name, values);
    }
  };

  updateErrors = (name: InternalFieldName, error: FieldError) => {
    set(this._formState.errors, name, error);
    this._subjects.state.next({
      errors: this._formState.errors,
    });
  };

  _setErrors = (errors: FieldErrors<TFieldValues>) => {
    this._formState.errors = errors;
    this._subjects.state.next({
      errors: this._formState.errors,
      isValid: false,
    });
  };

  updateValidAndValue = (
    name: InternalFieldName,
    shouldSkipSetValueAs: boolean,
    value?: unknown,
    ref?: Ref,
  ) => {
    const field: Field = get(this._fields, name);

    if (field) {
      const defaultValue = get(
        this._formValues,
        name,
        isUndefined(value) ? get(this._defaultValues, name) : value,
      );

      isUndefined(defaultValue) ||
      (ref && (ref as HTMLInputElement).defaultChecked) ||
      shouldSkipSetValueAs
        ? set(
            this._formValues,
            name,
            shouldSkipSetValueAs ? defaultValue : getFieldValue(field._f),
          )
        : this.setFieldValue(name, defaultValue);

      this._state.mount && !this._state.action && this._setValid();
    }
  };

  updateTouchAndDirty = (
    name: InternalFieldName,
    fieldValue: unknown,
    isBlurEvent?: boolean,
    shouldDirty?: boolean,
    shouldRender?: boolean,
  ): Partial<
    Pick<FormState<TFieldValues>, 'dirtyFields' | 'isDirty' | 'touchedFields'>
  > => {
    let shouldUpdateField = false;
    let isPreviousDirty = false;
    const output: Partial<FormState<TFieldValues>> & { name: string } = {
      name,
    };

    if (!this._options.disabled) {
      if (!isBlurEvent || shouldDirty) {
        if (
          this._proxyFormState.isDirty ||
          this._proxySubscribeFormState.isDirty
        ) {
          isPreviousDirty = this._formState.isDirty;
          this._formState.isDirty = output.isDirty = this._getDirty();
          shouldUpdateField = isPreviousDirty !== output.isDirty;
        }

        const isCurrentFieldPristine = deepEqual(
          get(this._defaultValues, name),
          fieldValue,
        );

        isPreviousDirty = !!get(this._formState.dirtyFields, name);
        isCurrentFieldPristine
          ? unset(this._formState.dirtyFields, name)
          : set(this._formState.dirtyFields, name, true);
        output.dirtyFields = this._formState.dirtyFields;
        shouldUpdateField =
          shouldUpdateField ||
          ((this._proxyFormState.dirtyFields ||
            this._proxySubscribeFormState.dirtyFields) &&
            isPreviousDirty !== !isCurrentFieldPristine);
      }

      if (isBlurEvent) {
        const isPreviousFieldTouched = get(this._formState.touchedFields, name);

        if (!isPreviousFieldTouched) {
          set(this._formState.touchedFields, name, isBlurEvent);
          output.touchedFields = this._formState.touchedFields;
          shouldUpdateField =
            shouldUpdateField ||
            ((this._proxyFormState.touchedFields ||
              this._proxySubscribeFormState.touchedFields) &&
              isPreviousFieldTouched !== isBlurEvent);
        }
      }

      shouldUpdateField && shouldRender && this._subjects.state.next(output);
    }

    return shouldUpdateField ? output : {};
  };

  shouldRenderByError = (
    name: InternalFieldName,
    isValid?: boolean,
    error?: FieldError,
    fieldState?: {
      dirty?: FieldNamesMarkedBoolean<TFieldValues>;
      isDirty?: boolean;
      touched?: FieldNamesMarkedBoolean<TFieldValues>;
    },
  ) => {
    const previousFieldError = get(this._formState.errors, name);
    const shouldUpdateValid =
      (this._proxyFormState.isValid || this._proxySubscribeFormState.isValid) &&
      isBoolean(isValid) &&
      this._formState.isValid !== isValid;

    if (this._options.delayError && error) {
      this.delayErrorCallback = this.debounce(() =>
        this.updateErrors(name, error),
      );
      this.delayErrorCallback(this._options.delayError);
    } else {
      clearTimeout(this.timer);
      this.delayErrorCallback = undefined;
      error
        ? set(this._formState.errors, name, error)
        : unset(this._formState.errors, name);
    }

    if (
      (error ? !deepEqual(previousFieldError, error) : previousFieldError) ||
      !isEmptyObject(fieldState) ||
      shouldUpdateValid
    ) {
      const updatedFormState = {
        ...fieldState,
        ...(shouldUpdateValid && isBoolean(isValid) ? { isValid } : {}),
        errors: this._formState.errors,
        name,
      };

      this._formState = {
        ...this._formState,
        ...updatedFormState,
      };

      this._subjects.state.next(updatedFormState);
    }
  };

  _runSchema = async (name?: InternalFieldName[]) => {
    this._updateIsValidating(name, true);
    return await this._options.resolver!(
      this._formValues as TFieldValues,
      this._options.context,
      getResolverOptions(
        name || this._names.mount,
        this._fields,
        this._options.criteriaMode,
        this._options.shouldUseNativeValidation,
      ),
    );
  };

  executeSchemaAndUpdateState = async (names?: InternalFieldName[]) => {
    const { errors } = await this._runSchema(names);
    this._updateIsValidating(names);

    if (names) {
      for (const name of names) {
        const error = get(errors, name);
        error
          ? set(this._formState.errors, name, error)
          : unset(this._formState.errors, name);
      }
    } else {
      this._formState.errors = errors;
    }

    return errors;
  };

  validateForm = async ({
    name,
    eventType,
  }: {
    name: FieldPath<TFieldValues> | FieldPath<TFieldValues>[] | undefined;
    eventType: ValidateFormEventType;
  }) => {
    if (this.props.validate) {
      const result = await this.props.validate({
        formValues: this._formValues,
        formState: this._formState,
        name,
        eventType,
      });

      if (isObject(result)) {
        for (const key in result) {
          const error = result[key];

          if (error) {
            this.setError(`${FORM_ERROR_TYPE}.${key}`, {
              message: isString(result.message) ? result.message : '',
              type: INPUT_VALIDATION_RULES.validate,
            });
          }
        }
      } else if (isString(result) || !result) {
        this.setError(FORM_ERROR_TYPE, {
          message: result || '',
          type: INPUT_VALIDATION_RULES.validate,
        });
      } else {
        this.clearErrors(FORM_ERROR_TYPE);
      }

      return result;
    }

    return true;
  };

  executeBuiltInValidation = async ({
    fields,
    onlyCheckValid,
    name,
    eventType,
    context = {
      valid: true,
      runRootValidation: false,
    },
  }: {
    fields: FieldRefs;
    onlyCheckValid?: boolean;
    name?: FieldPath<TFieldValues> | FieldPath<TFieldValues>[];
    eventType: ValidateFormEventType;
    context?: {
      valid: boolean;
      runRootValidation?: boolean;
    };
  }) => {
    if (this.props.validate) {
      context.runRootValidation = true;
      const result = await this.validateForm({
        name,
        eventType,
      });

      if (!result) {
        context.valid = false;

        if (onlyCheckValid) {
          return context.valid;
        }
      }
    }

    for (const name in fields) {
      const field = fields[name];

      if (field) {
        const { _f, ...fieldValue } = field as Field;

        if (_f) {
          const isFieldArrayRoot = this._names.array.has(_f.name);
          const isPromiseFunction =
            field._f && hasPromiseValidation((field as Field)._f);

          if (isPromiseFunction && this._proxyFormState.validatingFields) {
            this._updateIsValidating([_f.name], true);
          }

          const fieldError = await validateField(
            field as Field,
            this._names.disabled,
            this._formValues,
            this.shouldDisplayAllAssociatedErrors,
            this._options.shouldUseNativeValidation && !onlyCheckValid,
            isFieldArrayRoot,
          );

          if (isPromiseFunction && this._proxyFormState.validatingFields) {
            this._updateIsValidating([_f.name]);
          }

          if (fieldError[_f.name]) {
            context.valid = false;

            if (onlyCheckValid) {
              break;
            }
          }

          !onlyCheckValid &&
            (get(fieldError, _f.name)
              ? isFieldArrayRoot
                ? updateFieldArrayRootError(
                    this._formState.errors,
                    fieldError,
                    _f.name,
                  )
                : set(this._formState.errors, _f.name, fieldError[_f.name])
              : unset(this._formState.errors, _f.name));

          if (this.props.shouldUseNativeValidation && fieldError[_f.name]) {
            break;
          }
        }

        !isEmptyObject(fieldValue) &&
          (await this.executeBuiltInValidation({
            context,
            onlyCheckValid,
            fields: fieldValue,
            name: name as FieldPath<TFieldValues>,
            eventType,
          }));
      }
    }

    return context.valid;
  };

  _removeUnmounted = () => {
    for (const name of this._names.unMount) {
      const field: Field = get(this._fields, name);

      field &&
        (field._f.refs
          ? field._f.refs.every((ref) => !live(ref))
          : !live(field._f.ref)) &&
        this.unregister(name as FieldPath<TFieldValues>);
    }

    this._names.unMount = new Set();
  };

  _getDirty: GetIsDirty = (name, data) =>
    !this._options.disabled &&
    (name && data && set(this._formValues, name, data),
    !deepEqual(this.getValues(), this._defaultValues));

  _getWatch: WatchInternal<TFieldValues> = (names, defaultValue, isGlobal) =>
    generateWatchOutput(
      names,
      this._names,
      {
        ...(this._state.mount
          ? this._formValues
          : isUndefined(defaultValue)
            ? this._defaultValues
            : isString(names)
              ? { [names]: defaultValue }
              : defaultValue),
      },
      isGlobal,
      defaultValue,
    );

  _getFieldArray = <TFieldArrayValues>(
    name: InternalFieldName,
  ): Partial<TFieldArrayValues>[] =>
    compact(
      get(
        this._state.mount ? this._formValues : this._defaultValues,
        name,
        this._options.shouldUnregister
          ? get(this._defaultValues, name, [])
          : [],
      ),
    );

  setFieldValue = (
    name: InternalFieldName,
    value: SetFieldValue<TFieldValues>,
    options: SetValueConfig = {},
  ) => {
    const field: Field = get(this._fields, name);
    let fieldValue: unknown = value;

    if (field) {
      const fieldReference = field._f;

      if (fieldReference) {
        !fieldReference.disabled &&
          set(this._formValues, name, getFieldValueAs(value, fieldReference));

        fieldValue =
          isHTMLElement(fieldReference.ref) && isNullOrUndefined(value)
            ? ''
            : value;

        if (isMultipleSelect(fieldReference.ref)) {
          [...fieldReference.ref.options].forEach(
            (optionRef) =>
              (optionRef.selected = (
                fieldValue as InternalFieldName[]
              ).includes(optionRef.value)),
          );
        } else if (fieldReference.refs) {
          if (isCheckBoxInput(fieldReference.ref)) {
            fieldReference.refs.forEach((checkboxRef) => {
              if (!checkboxRef.defaultChecked || !checkboxRef.disabled) {
                if (Array.isArray(fieldValue)) {
                  checkboxRef.checked = !!fieldValue.find(
                    (data: string) => data === checkboxRef.value,
                  );
                } else {
                  checkboxRef.checked =
                    fieldValue === checkboxRef.value || !!fieldValue;
                }
              }
            });
          } else {
            fieldReference.refs.forEach(
              (radioRef: HTMLInputElement) =>
                (radioRef.checked = radioRef.value === fieldValue),
            );
          }
        } else if (isFileInput(fieldReference.ref)) {
          fieldReference.ref.value = '';
        } else {
          fieldReference.ref.value = fieldValue;

          if (!fieldReference.ref.type) {
            this._subjects.state.next({
              name,
              values: cloneObject(this._formValues),
            });
          }
        }
      }
    }

    (options.shouldDirty || options.shouldTouch) &&
      this.updateTouchAndDirty(
        name,
        fieldValue,
        options.shouldTouch,
        options.shouldDirty,
        true,
      );

    options.shouldValidate && this.trigger(name as Path<TFieldValues>);
  };

  setValues = <
    T extends InternalFieldName,
    K extends SetFieldValue<TFieldValues>,
    U extends SetValueConfig,
  >(
    name: T,
    value: K,
    options: U,
  ) => {
    for (const fieldKey in value) {
      if (!value.hasOwnProperty(fieldKey)) {
        return;
      }
      const fieldValue = value[fieldKey];
      const fieldName = name + '.' + fieldKey;
      const field = get(this._fields, fieldName);

      (this._names.array.has(name) ||
        isObject(fieldValue) ||
        (field && !field._f)) &&
      !isDateObject(fieldValue)
        ? this.setValues(fieldName, fieldValue, options)
        : this.setFieldValue(fieldName, fieldValue, options);
    }
  };

  setValue: UseFormSetValue<TFieldValues> = (name, value, options = {}) => {
    const field = get(this._fields, name);
    const isFieldArray = this._names.array.has(name);
    const cloneValue = cloneObject(value);
    const previousValue = get(this._formValues, name);
    const isValueUnchanged = deepEqual(previousValue, cloneValue);

    set(this._formValues, name, cloneValue);

    if (isFieldArray) {
      this._subjects.array.next({
        name,
        values: cloneObject(this._formValues),
      });

      if (options.shouldDirty) {
        this._updateDirtyFields(name);

        this._subjects.state.next({
          name,
          dirtyFields: this._formState.dirtyFields,
          isDirty: this._getDirty(name, cloneValue),
        });
      }
    } else {
      const isEmpty =
        (Array.isArray(cloneValue) && !cloneValue.length) ||
        isEmptyObject(cloneValue);

      if (!field || field._f || isNullOrUndefined(cloneValue) || isEmpty) {
        this.setFieldValue(name, cloneValue, options);
      } else {
        this.setValues(name, cloneValue, options);
      }
    }

    if (!isValueUnchanged) {
      if (isWatched(name, this._names)) {
        this._subjects.state.next({
          ...this._formState,
          name,
          values: cloneObject(this._formValues),
        });
      } else {
        this._subjects.state.next({
          name: this._state.mount ? name : undefined,
          values: cloneObject(this._formValues),
        });
      }
    }
  };

  onChange: ChangeHandler = async (event) => {
    this._state.mount = true;
    const target = event.target;
    let name: string = target.name;
    let isFieldValueUpdated = true;
    const field: Field = get(this._fields, name);
    const _updateIsFieldValueUpdated = (fieldValue: unknown) => {
      isFieldValueUpdated =
        Number.isNaN(fieldValue) ||
        (isDateObject(fieldValue) && isNaN(fieldValue.getTime())) ||
        deepEqual(fieldValue, get(this._formValues, name, fieldValue));
    };
    const validationModeBeforeSubmit = getValidationModes(this._options.mode);
    const validationModeAfterSubmit = getValidationModes(
      this._options.reValidateMode,
    );

    if (field) {
      let error;
      let isValid;
      const fieldValue = target.type
        ? getFieldValue(field._f)
        : getEventValue(event);
      const isBlurEvent =
        event.type === EVENTS.BLUR || event.type === EVENTS.FOCUS_OUT;
      const shouldSkipValidation =
        (!hasValidation(field._f) &&
          !this.props.validate &&
          !this._options.resolver &&
          !get(this._formState.errors, name) &&
          !field._f.deps) ||
        skipValidation(
          isBlurEvent,
          get(this._formState.touchedFields, name),
          this._formState.isSubmitted,
          validationModeAfterSubmit,
          validationModeBeforeSubmit,
        );
      const watched = isWatched(name, this._names, isBlurEvent);

      set(this._formValues, name, fieldValue);

      if (isBlurEvent) {
        if (!target || !target.readOnly) {
          field._f.onBlur && field._f.onBlur(event);
          this.delayErrorCallback && this.delayErrorCallback(0);
        }
      } else if (field._f.onChange) {
        field._f.onChange(event);
      }

      const fieldState = this.updateTouchAndDirty(
        name,
        fieldValue,
        isBlurEvent,
      );

      const shouldRender = !isEmptyObject(fieldState) || watched;

      !isBlurEvent &&
        this._subjects.state.next({
          name,
          type: event.type,
          values: cloneObject(this._formValues),
        });

      if (shouldSkipValidation) {
        if (
          this._proxyFormState.isValid ||
          this._proxySubscribeFormState.isValid
        ) {
          if (this._options.mode === 'onBlur') {
            if (isBlurEvent) {
              this._setValid();
            }
          } else if (!isBlurEvent) {
            this._setValid();
          }
        }

        return (
          shouldRender &&
          this._subjects.state.next({ name, ...(watched ? {} : fieldState) })
        );
      }

      if (!this._options.resolver && this.props.validate) {
        await this.validateForm({
          name: name as FieldPath<TFieldValues>,
          eventType: event.type,
        });
      }

      !isBlurEvent &&
        watched &&
        this._subjects.state.next({ ...this._formState });

      if (this._options.resolver) {
        const { errors } = await this._runSchema([name]);
        this._updateIsValidating([name]);

        _updateIsFieldValueUpdated(fieldValue);

        if (isFieldValueUpdated) {
          const previousErrorLookupResult = schemaErrorLookup(
            this._formState.errors,
            this._fields,
            name,
          );
          const errorLookupResult = schemaErrorLookup(
            errors,
            this._fields,
            previousErrorLookupResult.name || name,
          );

          error = errorLookupResult.error;
          name = errorLookupResult.name;

          isValid = isEmptyObject(errors);
        }
      } else {
        this._updateIsValidating([name], true);
        error = (
          await validateField(
            field,
            this._names.disabled,
            this._formValues,
            this.shouldDisplayAllAssociatedErrors,
            this._options.shouldUseNativeValidation,
          )
        )[name];
        this._updateIsValidating([name]);

        _updateIsFieldValueUpdated(fieldValue);

        if (isFieldValueUpdated) {
          if (error) {
            isValid = false;
          } else if (
            this._proxyFormState.isValid ||
            this._proxySubscribeFormState.isValid
          ) {
            isValid = await this.executeBuiltInValidation({
              fields: this._fields,
              onlyCheckValid: true,
              name: name as FieldPath<TFieldValues>,
              eventType: event.type,
            });
          }
        }
      }

      if (isFieldValueUpdated) {
        field._f.deps &&
          (!Array.isArray(field._f.deps) || field._f.deps.length > 0) &&
          this.trigger(
            field._f.deps as
              | FieldPath<TFieldValues>
              | FieldPath<TFieldValues>[],
          );
        this.shouldRenderByError(name, isValid, error, fieldState);
      }
    }
  };

  _focusInput = (ref: Ref, key: string) => {
    if (get(this._formState.errors, key) && ref.focus) {
      ref.focus();
      return 1;
    }
    return;
  };

  trigger: UseFormTrigger<TFieldValues> = async (name, options = {}) => {
    let isValid;
    let validationResult;
    const fieldNames = convertToArrayPayload(name) as InternalFieldName[];

    if (this._options.resolver) {
      const errors = await this.executeSchemaAndUpdateState(
        isUndefined(name) ? name : fieldNames,
      );

      isValid = isEmptyObject(errors);
      validationResult = name
        ? !fieldNames.some((name) => get(errors, name))
        : isValid;
    } else if (name) {
      validationResult = (
        await Promise.all(
          fieldNames.map(async (fieldName) => {
            const field = get(this._fields, fieldName);
            return await this.executeBuiltInValidation({
              fields: field && field._f ? { [fieldName]: field } : field,
              eventType: EVENTS.TRIGGER,
            });
          }),
        )
      ).every(Boolean);
      !(!validationResult && !this._formState.isValid) && this._setValid();
    } else {
      validationResult = isValid = await this.executeBuiltInValidation({
        fields: this._fields,
        name,
        eventType: EVENTS.TRIGGER,
      });
    }

    this._subjects.state.next({
      ...(!isString(name) ||
      ((this._proxyFormState.isValid ||
        this._proxySubscribeFormState.isValid) &&
        isValid !== this._formState.isValid)
        ? {}
        : { name }),
      ...(this._options.resolver || !name ? { isValid } : {}),
      errors: this._formState.errors,
    });

    options.shouldFocus &&
      !validationResult &&
      iterateFieldsByAction(
        this._fields,
        this._focusInput,
        name ? fieldNames : this._names.mount,
      );

    return validationResult;
  };

  getValues: UseFormGetValues<TFieldValues> = (
    fieldNames?:
      | FieldPath<TFieldValues>
      | ReadonlyArray<FieldPath<TFieldValues>>,
    config?: GetValuesConfig,
  ) => {
    let values = {
      ...(this._state.mount ? this._formValues : this._defaultValues),
    };

    if (config) {
      values = extractFormValues(
        config.dirtyFields
          ? this._formState.dirtyFields
          : this._formState.touchedFields,
        values,
      );
    }

    return isUndefined(fieldNames)
      ? values
      : isString(fieldNames)
        ? get(values, fieldNames)
        : fieldNames.map((name) => get(values, name));
  };

  getFieldState: UseFormGetFieldState<TFieldValues> = (name, formState) => ({
    invalid: !!get((formState || this._formState).errors, name),
    isDirty: !!get((formState || this._formState).dirtyFields, name),
    error: get((formState || this._formState).errors, name),
    isValidating: !!get(this._formState.validatingFields, name),
    isTouched: !!get((formState || this._formState).touchedFields, name),
  });

  clearErrors: UseFormClearErrors<TFieldValues> = (name) => {
    const names = name ? convertToArrayPayload(name) : undefined;

    names?.forEach((inputName) => unset(this._formState.errors, inputName));

    if (names) {
      // Emit for each cleared field with the field name so that
      // shouldSubscribeByName can filter and avoid broad re-renders
      names.forEach((inputName) => {
        this._subjects.state.next({
          name: inputName,
          errors: this._formState.errors,
        });
      });
    } else {
      // Clear all errors - emit without name to notify all subscribers
      this._subjects.state.next({
        errors: {},
      });
    }
  };

  setError: UseFormSetError<TFieldValues> = (name, error, options) => {
    const ref = (get(this._fields, name, { _f: {} })._f || {}).ref;
    const currentError = get(this._formState.errors, name) || {};

    // Don't override existing error messages elsewhere in the object tree.
    const { ref: currentRef, message, type, ...restOfErrorTree } = currentError;

    set(this._formState.errors, name, {
      ...restOfErrorTree,
      ...error,
      ref,
    });

    this._subjects.state.next({
      name,
      errors: this._formState.errors,
      isValid: false,
    });

    options && options.shouldFocus && ref && ref.focus && ref.focus();
  };

  watch: UseFormWatch<TFieldValues> = (
    name?:
      | FieldPath<TFieldValues>
      | ReadonlyArray<FieldPath<TFieldValues>>
      | WatchObserver<TFieldValues>,
    defaultValue?: DeepPartial<TFieldValues>,
  ) =>
    isFunction(name)
      ? this._subjects.state.subscribe({
          next: (payload) =>
            'values' in payload &&
            name(
              payload.values || this._getWatch(undefined, defaultValue),
              payload as {
                name?: FieldPath<TFieldValues>;
                type?: EventType;
                value?: unknown;
              },
            ),
        })
      : this._getWatch(
          name as InternalFieldName | InternalFieldName[],
          defaultValue,
          true,
        );

  _subscribe: FromSubscribe<TFieldValues> = (props) =>
    this._subjects.state.subscribe({
      next: (
        formState: Partial<FormState<TFieldValues>> & {
          name?: InternalFieldName;
          values?: TFieldValues | undefined;
          type?: EventType;
        },
      ) => {
        if (
          shouldSubscribeByName(props.name, formState.name, props.exact) &&
          shouldRenderFormState(
            formState,
            (props.formState as ReadFormState) || this._proxyFormState,
            this._setFormState,
            props.reRenderRoot,
          )
        ) {
          const snapshot = { ...this._formValues } as TFieldValues;

          props.callback({
            values: snapshot,
            ...this._formState,
            ...formState,
            defaultValues: this
              ._defaultValues as FormState<TFieldValues>['defaultValues'],
          });
        }
      },
    }).unsubscribe;

  subscribe: UseFormSubscribe<TFieldValues> = (props) => {
    this._state.mount = true;
    this._proxySubscribeFormState = {
      ...this._proxySubscribeFormState,
      ...props.formState,
    };
    return this._subscribe({
      ...props,
      formState: {
        ...defaultProxyFormState,
        ...props.formState,
      },
    });
  };

  unregister: UseFormUnregister<TFieldValues> = (name, options = {}) => {
    for (const fieldName of name
      ? convertToArrayPayload(name)
      : this._names.mount) {
      this._names.mount.delete(fieldName);
      this._names.array.delete(fieldName);

      if (!options.keepValue) {
        unset(this._fields, fieldName);
        unset(this._formValues, fieldName);
      }

      !options.keepError && unset(this._formState.errors, fieldName);
      !options.keepDirty && unset(this._formState.dirtyFields, fieldName);
      !options.keepTouched && unset(this._formState.touchedFields, fieldName);
      !options.keepIsValidating &&
        unset(this._formState.validatingFields, fieldName);
      !this._options.shouldUnregister &&
        !options.keepDefaultValue &&
        unset(this._defaultValues, fieldName);
    }

    this._subjects.state.next({
      values: cloneObject(this._formValues),
    });

    this._subjects.state.next({
      ...this._formState,
      ...(!options.keepDirty ? {} : { isDirty: this._getDirty() }),
    });

    !options.keepIsValid && this._setValid();
  };

  _setDisabledField: Control<TFieldValues>['_setDisabledField'] = ({
    disabled,
    name,
  }) => {
    if (
      (isBoolean(disabled) && this._state.mount) ||
      !!disabled ||
      this._names.disabled.has(name)
    ) {
      const wasDisabled = this._names.disabled.has(name);
      const isDisabled = !!disabled;
      const disabledStateChanged = wasDisabled !== isDisabled;

      disabled
        ? this._names.disabled.add(name)
        : this._names.disabled.delete(name);
      disabledStateChanged &&
        this._state.mount &&
        !this._state.action &&
        this._setValid();
    }
  };

  register: UseFormRegister<TFieldValues> = (name, options = {}) => {
    let field = get(this._fields, name);
    const disabledIsDefined =
      isBoolean(options.disabled) || isBoolean(this._options.disabled);
    const shouldRevalidateRemount =
      !this._names.registerName.has(name) &&
      field &&
      field._f &&
      !field._f.mount;

    set(this._fields, name, {
      ...(field || {}),
      _f: {
        ...(field && field._f ? field._f : { ref: { name } }),
        name,
        mount: true,
        ...options,
      },
    });
    this._names.mount.add(name);

    if (field && !shouldRevalidateRemount) {
      this._setDisabledField({
        disabled: isBoolean(options.disabled)
          ? options.disabled
          : this._options.disabled,
        name,
      });
    } else {
      this.updateValidAndValue(name, true, options.value);
    }

    return {
      ...(disabledIsDefined
        ? { disabled: options.disabled || this._options.disabled }
        : {}),
      ...(this._options.progressive
        ? {
            required: !!options.required,
            min: getRuleValue(options.min),
            max: getRuleValue(options.max),
            minLength: getRuleValue<number>(options.minLength) as number,
            maxLength: getRuleValue(options.maxLength) as number,
            pattern: getRuleValue(options.pattern) as string,
          }
        : {}),
      name,
      onChange: this.onChange,
      onBlur: this.onChange,
      ref: (ref: HTMLInputElement | null): void => {
        if (ref) {
          this._names.registerName.add(name);
          this.register(name, options);
          this._names.registerName.delete(name);
          field = get(this._fields, name);

          const fieldRef = isUndefined(ref.value)
            ? ref.querySelectorAll
              ? (ref.querySelectorAll('input,select,textarea')[0] as Ref) || ref
              : ref
            : ref;
          const radioOrCheckbox = isRadioOrCheckbox(fieldRef);
          const refs = field._f.refs || [];

          if (
            radioOrCheckbox
              ? refs.find((option: Ref) => option === fieldRef)
              : fieldRef === field._f.ref
          ) {
            return;
          }

          set(this._fields, name, {
            _f: {
              ...field._f,
              ...(radioOrCheckbox
                ? {
                    refs: [
                      ...refs.filter(live),
                      fieldRef,
                      ...(Array.isArray(get(this._defaultValues, name))
                        ? [{}]
                        : []),
                    ],
                    ref: { type: fieldRef.type, name },
                  }
                : { ref: fieldRef }),
            },
          });

          this.updateValidAndValue(name, false, undefined, fieldRef);
        } else {
          field = get(this._fields, name, {});

          if (field._f) {
            field._f.mount = false;
          }

          (this._options.shouldUnregister || options.shouldUnregister) &&
            !(
              isNameInFieldArray(this._names.array, name) && this._state.action
            ) &&
            this._names.unMount.add(name);
        }
      },
    };
  };

  _focusError = () =>
    this._options.shouldFocusError &&
    iterateFieldsByAction(this._fields, this._focusInput, this._names.mount);

  _disableForm = (disabled?: boolean) => {
    if (isBoolean(disabled)) {
      this._subjects.state.next({ disabled });
      iterateFieldsByAction(
        this._fields,
        (ref, name) => {
          const currentField: Field = get(this._fields, name);
          if (currentField) {
            ref.disabled = currentField._f.disabled || disabled;

            if (Array.isArray(currentField._f.refs)) {
              currentField._f.refs.forEach((inputRef) => {
                inputRef.disabled = currentField._f.disabled || disabled;
              });
            }
          }
        },
        0,
        false,
      );
    }
  };

  handleSubmit: UseFormHandleSubmit<TFieldValues, TTransformedValues> =
    (onValid, onInvalid) => async (e) => {
      let onValidError = undefined;
      if (e) {
        e.preventDefault && e.preventDefault();
        (e as React.BaseSyntheticEvent).persist &&
          (e as React.BaseSyntheticEvent).persist();
      }
      let fieldValues:
        | TFieldValues
        | TTransformedValues
        | Record<string, never> = cloneObject(this._formValues);

      this._subjects.state.next({
        isSubmitting: true,
      });

      if (this._options.resolver) {
        const { errors, values } = await this._runSchema();
        this._updateIsValidating();
        this._formState.errors = errors;
        fieldValues = cloneObject(values);
      } else {
        await this.executeBuiltInValidation({
          fields: this._fields,
          eventType: EVENTS.SUBMIT,
        });
      }

      if (this._names.disabled.size) {
        for (const name of this._names.disabled) {
          unset(fieldValues, name);
        }
      }

      unset(this._formState.errors, ROOT_ERROR_TYPE);

      if (isEmptyObject(this._formState.errors)) {
        this._subjects.state.next({
          errors: {},
        });
        try {
          await onValid(fieldValues as TTransformedValues, e);
        } catch (error) {
          onValidError = error;
        }
      } else {
        if (onInvalid) {
          await onInvalid({ ...this._formState.errors }, e);
        }
        this._focusError();
        setTimeout(this._focusError);
      }

      this._subjects.state.next({
        isSubmitted: true,
        isSubmitting: false,
        isSubmitSuccessful:
          isEmptyObject(this._formState.errors) && !onValidError,
        submitCount: this._formState.submitCount + 1,
        errors: this._formState.errors,
      });
      if (onValidError) {
        throw onValidError;
      }
    };

  resetField: UseFormResetField<TFieldValues> = (name, options = {}) => {
    if (get(this._fields, name)) {
      if (isUndefined(options.defaultValue)) {
        this.setValue(name, cloneObject(get(this._defaultValues, name)));
      } else {
        this.setValue(
          name,
          options.defaultValue as Parameters<
            typeof this.setValue<typeof name>
          >[1],
        );
        set(this._defaultValues, name, cloneObject(options.defaultValue));
      }

      if (!options.keepTouched) {
        unset(this._formState.touchedFields, name);
      }

      if (!options.keepDirty) {
        unset(this._formState.dirtyFields, name);
        this._formState.isDirty = options.defaultValue
          ? this._getDirty(name, cloneObject(get(this._defaultValues, name)))
          : this._getDirty();
      }

      if (!options.keepError) {
        unset(this._formState.errors, name);
        this._proxyFormState.isValid && this._setValid();
      }

      this._subjects.state.next({ ...this._formState });
    }
  };

  _reset: UseFormReset<TFieldValues> = (formValues, keepStateOptions = {}) => {
    const updatedValues = formValues
      ? cloneObject(formValues)
      : this._defaultValues;
    const cloneUpdatedValues = cloneObject(updatedValues);
    const isEmptyResetValues = isEmptyObject(formValues);
    const values = isEmptyResetValues
      ? this._defaultValues
      : cloneUpdatedValues;

    if (!keepStateOptions.keepDefaultValues) {
      this._defaultValues = updatedValues;
    }

    if (!keepStateOptions.keepValues) {
      if (keepStateOptions.keepDirtyValues) {
        const fieldsToCheck = new Set([
          ...this._names.mount,
          ...Object.keys(getDirtyFields(this._defaultValues, this._formValues)),
        ]);
        for (const fieldName of Array.from(fieldsToCheck)) {
          const isDirty = get(this._formState.dirtyFields, fieldName);
          const existingValue = get(this._formValues, fieldName);
          const newValue = get(values, fieldName);

          if (isDirty && !isUndefined(existingValue)) {
            set(values, fieldName, existingValue);
          } else if (!isDirty && !isUndefined(newValue)) {
            this.setValue(fieldName as FieldPath<TFieldValues>, newValue);
          }
        }
      } else {
        if (isWeb && isUndefined(formValues)) {
          for (const name of this._names.mount) {
            const field = get(this._fields, name);
            if (field && field._f) {
              const fieldReference = Array.isArray(field._f.refs)
                ? field._f.refs[0]
                : field._f.ref;

              if (isHTMLElement(fieldReference)) {
                const form = fieldReference.closest('form');
                if (form) {
                  form.reset();
                  break;
                }
              }
            }
          }
        }

        if (keepStateOptions.keepFieldsRef) {
          for (const fieldName of this._names.mount) {
            this.setValue(
              fieldName as FieldPath<TFieldValues>,
              get(values, fieldName),
            );
          }
        } else {
          this._fields = {};
        }
      }

      this._formValues = this._options.shouldUnregister
        ? keepStateOptions.keepDefaultValues
          ? (cloneObject(this._defaultValues) as TFieldValues)
          : ({} as TFieldValues)
        : (cloneObject(values) as TFieldValues);

      this._subjects.array.next({
        values: { ...values },
      });

      this._subjects.state.next({
        values: { ...values } as TFieldValues,
      });
    }

    this._names = {
      mount: keepStateOptions.keepDirtyValues ? this._names.mount : new Set(),
      unMount: new Set(),
      array: new Set(),
      registerName: new Set(),
      disabled: new Set(),
      watch: new Set(),
      watchAll: false,
      focus: '',
    };

    this._state.mount =
      !this._proxyFormState.isValid ||
      !!keepStateOptions.keepIsValid ||
      !!keepStateOptions.keepDirtyValues ||
      (!this._options.shouldUnregister && !isEmptyObject(values));

    this._state.watch = !!this._options.shouldUnregister;
    this._state.keepIsValid = !!keepStateOptions.keepIsValid;
    this._state.action = false;

    // Clear errors synchronously to prevent validation errors on subsequent submissions
    // This fixes the issue where form.reset() causes validation errors on subsequent
    // submissions in Next.js 16 with Server Actions
    if (!keepStateOptions.keepErrors) {
      this._formState.errors = {};
    }

    this._subjects.state.next({
      submitCount: keepStateOptions.keepSubmitCount
        ? this._formState.submitCount
        : 0,
      isDirty: isEmptyResetValues
        ? false
        : keepStateOptions.keepDirty
          ? this._formState.isDirty
          : !!(
              keepStateOptions.keepDefaultValues &&
              !deepEqual(formValues, this._defaultValues)
            ),
      isSubmitted: keepStateOptions.keepIsSubmitted
        ? this._formState.isSubmitted
        : false,
      dirtyFields: isEmptyResetValues
        ? {}
        : keepStateOptions.keepDirtyValues
          ? keepStateOptions.keepDefaultValues && this._formValues
            ? getDirtyFields(this._defaultValues, this._formValues)
            : this._formState.dirtyFields
          : keepStateOptions.keepDefaultValues && formValues
            ? getDirtyFields(this._defaultValues, formValues)
            : keepStateOptions.keepDirty
              ? this._formState.dirtyFields
              : {},
      touchedFields: keepStateOptions.keepTouched
        ? this._formState.touchedFields
        : {},
      errors: keepStateOptions.keepErrors ? this._formState.errors : {},
      isSubmitSuccessful: keepStateOptions.keepIsSubmitSuccessful
        ? this._formState.isSubmitSuccessful
        : false,
      isSubmitting: false,
      defaultValues: this
        ._defaultValues as FormState<TFieldValues>['defaultValues'],
    });
  };

  reset: UseFormReset<TFieldValues> = (formValues, keepStateOptions) =>
    this._reset(
      isFunction(formValues) ? formValues(this._formValues) : formValues,
      { ...this._options.resetOptions, ...keepStateOptions },
    );

  setFocus: UseFormSetFocus<TFieldValues> = (name, options = {}) => {
    const field = get(this._fields, name);
    const fieldReference = field && field._f;

    if (fieldReference) {
      const fieldRef = fieldReference.refs
        ? fieldReference.refs[0]
        : fieldReference.ref;

      if (fieldRef.focus) {
        // Use setTimeout to ensure focus happens after any pending state updates
        // This fixes the issue where setFocus doesn't work immediately after setError
        setTimeout(() => {
          fieldRef.focus();
          options.shouldSelect &&
            isFunction(fieldRef.select) &&
            fieldRef.select();
        });
      }
    }
  };

  _setFormState = (updatedFormState: Partial<FormState<TFieldValues>>) => {
    this._formState = {
      ...this._formState,
      ...updatedFormState,
    };
  };

  _resetDefaultValues = () =>
    isFunction(this._options.defaultValues) &&
    (this._options.defaultValues as Function)().then((values: TFieldValues) => {
      this.reset(values, this._options.resetOptions);
      this._subjects.state.next({
        isLoading: false,
      });
    });
}

export { FormControl };
